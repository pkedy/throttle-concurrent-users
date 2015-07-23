var proxy 	= require('proxy-middleware'),
	url 	= require('url'),
	uuid 	= require('node-uuid'),
	path 	= require('path'),
	//redis 	= require('redis'),
	Q 		= require('q'),
	_ 		= require('lodash');

var filteredExtensions = ['.gif', '.jpg', '.jpeg', '.png', '.css', '.js', '.ico', '.woff', '.woff2', '.eot', '.svg', '.ttf'];

var maxAllowed = 10;
var activeTimeout = 60 * 1;
var waitingTimeout = 60 * 10;

var locked = false;

var client = null;

var debugEnabled = false;

function debug() {
	if (debugEnabled) {
		console.log.apply(null, arguments);
	}
}

function cleanup() {
	debug('Clean up called');
	var expiry = new Date().getTime() - (activeTimeout * 1000);
	var count = 0;

	client.hgetall('active', function(err, active) {
		if (!active) {
			setTimeout(cleanup, 60000);

			return;
		}

		debug(active);
		var del = ['active'];

		for (var queueId in active) {
			var last = parseInt(active[queueId]);
			debug('testing if expired', queueId, last);

			if (last < expiry) {
				debug('cleaning up', queueId);
				del.push(queueId);
			}
		}

		if (del.length > 1) {
			debug('cleaning up', del);
			client.hdel(del, function(err, reply) {
				debug(err, reply);
				enqueue();
			});			
		} else {
			enqueue();
		}

		setTimeout(cleanup, 60000);
	});
}

function enqueue() {
	client.hlen('active', function(err, length) {
		if (length < maxAllowed) {
			if (locked) {
				return;
			}

			locked = true;
			debug('locked');

			client.lrange('queue', 0, maxAllowed - length, function(err, items) {
				if (!items || items.length == 0) {
					locked = false;
					debug('unlocked - no queue');
					return;
				}

				debug('setting as active', items);
				var now = new Date().getTime();
				var qs = [];
				var set = {};
				var again = false;
				var promise = null;
					var nq = Q.defer();

				_.each(items, function(next) {
					debug('next', next);

					function checkWaiting() {
						var nq = Q.defer();

						client.exists('waiting:' + next, function(err, exists) {
							debug('waiting exists', next, exists);

							if (exists == 1) {
								debug('setting', next, now);
								set[next] = now;
							} else {
								debug('again is true');
								again = true;
							}

							nq.resolve();
						});

						return nq.promise;
					}

					if (promise) {
						var temp = checkWaiting();
						promise.then(temp);
						promise = temp;
					} else {
						promise = checkWaiting();
					}
				});

				if (promise) {
					promise.then(function() {
						debug('setting', set);
						client.hmset('active', set, function(err) {
							client.srem('queueSet', items, function(err) {
								client.ltrim('queue', items.length, -1);
								debug('unlocked - enqueued ', items.length);
								locked = false;

								if (again) {
									process.nextTick(enqueue);
								}
							});
						});
					});
				}
			});
		}
	});
}

function release(queueId) {
	client.hdel('active', queueId, function(err, reply) {
		debug('removed', reply);
		enqueue();
	});
}

function touch(queueId) {
	var now = new Date().getTime();
	client.hmset('active', queueId, now);
}

function push(queueId, res) {
	client.sismember('queueSet', queueId, function(err, exists) {
		if (exists == 0) {
			client.sadd('queueSet', queueId, function(err, reply) {
				client.rpush(['queue', queueId], function(err, reply) {
					debug(reply);
					client.set('waiting:' + queueId, new Date().getTime(), function(err) {
						debug('expire', queueId);
						client.expire('waiting:' + queueId, waitingTimeout, function(err) {
							res.end('Too busy');
						});
					});
				});
			});
		} else {
			res.end('Too busy');
		}
	});
}

function checkQueue(queueId, res, next) {
	client.llen('queue', function(err, length) {
		if (length == 0) {
			client.hlen('active', function(err, length) {
				if (length < maxAllowed) {
					debug("Active " + queueId);
					touch(queueId);
					next();
				} else {
					debug("Waiting " + queueId);
					push(queueId, res);
				}
			});
		} else {
			push(queueId, res);
		}
	});
}

module.exports = {
	setClient: function(redisClient) {
		client = redisClient;
	},

	setOptions: function(options) {
		maxAllowed = options.maxAllowed || maxAllowed;
		activeTimeout = options.activeTimeout || activeTimeout;
		waitingTimeout = options.waitingTimeout || waitingTimeout;
	},

	startCleanup: function() {
		process.nextTick(cleanup);
	},

	proxy: function(baseUrl) {
		var proxyUrl= (baseUrl || 'http://localhost:8080');
		var options = url.parse(proxyUrl);

		return proxy(options);
	},

	preFilter: function() {
		return function(req, res, next) {
			if (req.url == '/user_queue/check') {
				var queueId = req.cookies['queue_id'];

				if (!queueId) {
					queueId = uuid.v4().replace(/\-/g, '');
					debug('sending back cookie:', queueId);
					res.setHeader('Set-Cookie', 'queue_id=' + queueId + '; path=/');
					res.end({status: 'WAITING'});

					return;
				}

				client.hmget('active', queueId, function(err, object) {
					var ready = object != null;

					if (!ready) {
						client.expire('waiting:' + queueId, waitingTimeout);
					}

					res.end({
						ready: ready ? 'READY' : 'WAITING'
					});
				});

				return;
			} else if (req.url == '/user_queue/release') {
				var queueId = req.cookies['queue_id'];

				if (queueId) {
					release(queueId);
					res.end('OK');
				} else {
					res.end('FAIL');
				}

				return;
			}

			var ext = path.extname(req.url.split('?')[0].toLowerCase());
			
			if (filteredExtensions.indexOf(ext) == -1 && req.url.indexOf('bundles') == -1) {
				var queueId = req.cookies['queue_id'];

				if (!queueId) {
					queueId = uuid.v4().replace(/\-/g, '');
					debug('sending back cookie:', queueId);
					res.setHeader('Set-Cookie', 'queue_id=' + queueId + '; path=/');
					checkQueue(queueId, res, next);
				} else {
					client.hexists('active', queueId, function(err, exists) {
						if (exists == 1) {
							touch(queueId);
							next();
						} else {
							checkQueue(queueId, res, next);
						}
					});
				}
			} else {
				next();
			}
		}
	}
}