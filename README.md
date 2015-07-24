"Throttle Users" Reverse Proxy
=============================

A Node.js and Redis-based proxy that allows only a maximum number of users into the site.  Once the maximum count is reached, subsequent users are placed into a queue until the active users start leaving.

### Setup

1.	Run `npm install`
2.	Start Redis and configure the host/port in proxy.js
3.	Change baseUrl (default http://localhost:80) or the listening port (default 9000) if needed in proxy.js
3.	On one web server run, `node.js proxy.js --cleanup` (this enables the background process to cleanup expired sessions)
4.	On all other web servers run, `node.js proxy.js` (you don't want the cleanup process running on more than one server)
5.	Point your load balancer to port 9000 instead of 80 (or changed values)