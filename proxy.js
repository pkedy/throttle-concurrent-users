var connect = require('connect');
var http = require('http');
var throttle = require('./lib/throttle.js');
var cookieParser = require('cookie-parser');
var redis 	= require('redis');

var baseUrl = 'http://localhost:80';
var cleanup = process.argv.indexOf('--cleanup') != -1;

var options = {
	maxAllowed: 2,
	activeTimeout: 60 * 1,
	waitingTimeout: 60 * 5
}

function initializeHttp() {
	var app = connect();

	app.use(cookieParser());
	app.use(throttle.preFilter());
	app.use(throttle.proxy(baseUrl));

	http.createServer(app).listen(9000);
}

var client = redis.createClient(6379, 'localhost');
client.on('connect', function() {
	console.log('Connected to Redis... Starting http server.');

	throttle.setClient(client);
	throttle.setOptions(options);
	initializeHttp();

	if (cleanup) {
		console.log('Starting background cleanup process.');
		throttle.startCleanup();	
	}
});