var P = require('bluebird');
var Hapi = require('hapi');
var path = require('path');
var redisConfig = require("url").parse(process.env.REDIS_URL);
var redis = require('redis');
var FailoverRedis = require('./failover-redis');
var GenericPool = require('generic-pool').Pool;
var cache = require('./cache');

module.exports = makeServer;

var TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

function makeServer(config) {
  var persistentRedis = new FailoverRedis(process.env.PERSISTENT_REDIS_URL || process.env.REDIS_URL);

  var cacheRedisPool = new GenericPool({
    name: 'cache-redis',
    max: 10,
    min: 1,
    idleTimeoutMillis: 30000,
    create: function(cb) {
      var client = redis.createClient(process.env.CACHE_REDIS_URL || process.env.REDIS_URL);

      client.on('connect', function() {
        client.removeListener('error', cb);
        cb(null, client);
      });

      client.on('error', cb);
    },
    destroy: function(client) {
      client.end();
    }
  });

  return P.resolve().then(function() {
    var server = new Hapi.Server({
      cache: {
        engine: require('catbox-redis'),
        client: persistentRedis
      },
      connections: {
        router: {
          stripTrailingSlash: true
        },
        routes: {
          security: {
            hsts: {
              maxAge: 1000 * 60 * 60 * 24 * 30,
              includeSubdomains: true
            },
            xframe: true
          }
        }
      }
    });

    server.connection(config.connection);

    server.stamp = require("./stamp")();
    server.gitHead = require("./git-head")();

    server.cacheRedisPool = cacheRedisPool;
    server.persistentRedis = persistentRedis;

    // configure http request cache
    cache.configure({
      redis: server.cacheRedis,
      ttl: 500,
      prefix: "cache:"
    });

    return P.promisify(server.register, server)(require('hapi-auth-cookie')).then(function() {
      var cache = server.cache({
        expiresIn: TWO_WEEKS,
        segment: '|sessions'
      });

      server.app.cache = cache;

      server.auth.strategy('session', 'cookie', 'required', {
        password: process.env.SESSION_PASSWORD,
        appendNext: 'done',
        redirectTo: '/login',
        cookie: process.env.SESSION_COOKIE,
        clearInvalid: true,
        validateFunc: function(session, cb) {
          P.promisify(cache.get, cache)(session.sid).catch(function(err) {
            cb(err, false);
          }).spread(function(item, cached) {
            if (!cached) {
              cb(null, false);
            } else {
              cb(null, true, item);
            }
          });
        }
      });

    }).then(function() {
      var plugins = require('./../adapters/plugins');

      return P.promisify(server.register, server)(plugins).then(function() {
        server.views({
          engines: {
            hbs: require('handlebars')
          },
          relativeTo: path.resolve(__dirname, '..'),
          path: './templates',
          helpersPath: './templates/helpers',
          layoutPath: './templates/layouts',
          partialsPath: './templates/partials',
          layout: 'default'
        });

        server.route(require('./../routes/index'));
      }).then(function() {
        return P.promisify(server.start, server)();
      }).then(function() {
        return server;
      });
    });
  });
}
