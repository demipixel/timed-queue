'use strict'

// **Github:** https://github.com/teambition/timed-queue
//
// **License:** MIT

var fs = require('fs')
var util = require('util')
var thunks = require('thunks')
var redis = require('thunk-redis')
var EventEmitter = require('events').EventEmitter
var luaScript = fs.readFileSync(__dirname + '/lua/queue.lua', {encoding: 'utf8'})

var thunk = thunks()
module.exports = TimedQueue

function TimedQueue (options) {
  options = options || {}

  this.prefix = options.prefix || 'TIMEDQ'
  this.queuesKey = '{' + this.prefix + '}:QUEUES'
  this.count = Math.floor(options.count) || 64
  this.interval = Math.floor(options.interval) || 1000 * 120
  this.expire = Math.floor(options.expire) || this.interval * 5
  this.retry = Math.floor(options.retry) || Math.floor(this.interval / 2)
  this.accuracy = Math.floor(options.accuracy) || Math.floor(this.interval / 5)
  this.autoScan = options.autoScan !== false

  this.redis = null
  this.timer = null
  this.scanTime = 0
  this.scanning = false
  this.scanQueue = null
  this.delay = this.interval
  this.queues = Object.create(null)
  this.scanQueue = null

  var ctx = this
  this.thunk = thunks(function (error) {
    ctx.emit('error', error)
  })
  EventEmitter.call(this)
}
util.inherits(TimedQueue, EventEmitter)

TimedQueue.prototype.connect = function () {
  var ctx = this
  if (this.redis) return this
  this.redis = redis.createClient.apply(null, arguments)
    .on('connect', function () {
      ctx.emit('connect')
    })
    .on('error', function (error) {
      ctx.emit('error', error)
    })
    .on('close', function () {
      ctx.emit('close')
    })

  this.scanQueue = this.thunk.persist.call(this, this.redis.script('load', luaScript))
  // auto scan jobs
  if (this.autoScan) {
    thunk.delay.call(this, Math.random() * this.interval)(function () {
      this.scan()
    })
  }
  return this
}

TimedQueue.prototype.scan = function () {
  if (this.scanning || !this.redis) return this

  var ctx = this
  var scanStart
  this.scanning = true
  this.scanTime = scanStart = Date.now()

  this.redis.smembers(this.queuesKey)(function (err, queues) {
    if (err) throw err
    ctx.emit('scanStart', queues.length)
    return thunk.seq(queues.map(function (queue) {
      return ctx.queue(queue).scan()
    }))
  })(function (err, queueScores) {
    if (err) ctx.emit('error', err)
    else {
      ctx.emit('scanEnd', queueScores.length, Date.now() - scanStart)

      var count = 0
      var score = queueScores.reduce(function (prev, scores) {
        return prev + scores.reduce(function (p, s) {
          count++
          return p + s
        }, 0)
      }, 0)
      if (count) ctx.regulateFreq(score / count)
    }

    if (!ctx.timer && ctx.scanning) {
      ctx.scanning = false
      ctx.scan()
    } else ctx.scanning = false
  })

  clearTimeout(this.timer)
  this.timer = setTimeout(function () {
    ctx.timer = null
    if (!ctx.scanning) ctx.scan()
  }, this.delay)

  return this
}

TimedQueue.prototype.stop = function () {
  clearTimeout(this.timer)
  this.scanning = false
  this.timer = null
  return this
}

TimedQueue.prototype.close = function () {
  this.stop()
  this.redis.clientEnd()
  this.redis = null
  return this
}

TimedQueue.prototype.queue = function (queueName, options) {
  validateString(queueName)
  if (!this.queues[queueName]) this.queues[queueName] = new Queue(this, queueName, options)
  else if (options) this.queues[queueName].init(options)
  return this.queues[queueName]
}

TimedQueue.prototype.destroyQueue = function (queueName) {
  return thunk.call(this, function (done) {
    var redis = this.redis
    var queue = this.queues[queueName]
    if (!queue) return done()

    delete this.queues[queueName]
    thunk.all([
      redis.srem(this.queuesKey, queue.name),
      redis.del(queue.queueOptionsKey),
      redis.del(queue.activeQueueKey),
      redis.del(queue.queueKey)
    ])(function (err) {
      done(err, null)
    })
  })
}

TimedQueue.prototype.regulateFreq = function (factor) {
  if (factor < -0.1) this.delay = Math.max(this.delay * (1 + factor), this.interval / 10)
  else if (factor > 0.1) this.delay = Math.min(this.delay * (1 + factor), this.interval * 5)
}

function Queue (timedQueue, queueName, options) {
  this.root = timedQueue
  this.name = queueName
  this.queueKey = '{' + timedQueue.prefix + ':' + queueName + '}' // hash tag
  this.activeQueueKey = this.queueKey + ':-'
  this.queueOptionsKey = this.queueKey + ':O'
  this.init(options)
  EventEmitter.call(this)
}
util.inherits(Queue, EventEmitter)

Queue.prototype.init = function (options) {
  var root = this.root
  root.thunk(root.redis.sadd(root.queuesKey, this.name))()

  if (!options) return this
  root.thunk(root.redis.hmset(this.queueOptionsKey, {
    count: options.count || root.count,
    retry: options.retry || root.retry,
    expire: options.expire || root.expire,
    accuracy: options.accuracy || root.accuracy
  }))()
  return this
}

Queue.prototype.addjob = function (job, timing) {
  var args = Array.isArray(job) ? job : slice(arguments)
  return thunk.call(this, function (done) {
    var data = [this.queueKey]
    var current = Date.now()

    for (var i = 0, l = args.length || 2; i < l; i += 2) {
      validateString(args[i])
      timing = Math.floor(args[i + 1])
      if (!timing || timing <= current) throw new Error(String(args[i + 1]) + ' is invalid time')
      data.push(timing, args[i])
    }

    this.root.redis.zadd(data)(done)
  })
}

Queue.prototype.show = function (job) {
  return thunk.call(this, function (done) {
    var ctx = this
    validateString(job)

    ctx.root.redis.zscore(ctx.queueKey, job)(function (err, timing) {
      if (err) throw err
      if (timing) return new Job(ctx.name, job, timing, 0, 0)

      return this.hget(ctx.activeQueueKey, job)(function (err, times) {
        if (err) throw err
        if (!times) return null
        times = times.split(':')
        return new Job(ctx.name, job, times[0], times[1], times.length - 2)
      })
    })(done)
  })
}

Queue.prototype.deljob = function (job) {
  var args = Array.isArray(job) ? job : slice(arguments)
  return thunk.call(this, function (done) {
    var ctx = this
    for (var i = 0, l = args.length || 1; i < l; i++) validateString(args[i])

    args.unshift(ctx.queueKey)
    ctx.root.redis.zrem(args)(function (err, count) {
      if (err) throw err
      args[0] = ctx.activeQueueKey
      return this.hdel(args)(function (err, _count) {
        if (err) throw err
        return count + _count
      })
    })(done)
  })
}

Queue.prototype.getjobs = function (scanActive) {
  return thunk.call(this, function (done) {
    var ctx = this
    var root = this.root
    var timestamp = Date.now()

    thunk(root.scanQueue)(function (_, luaSHA) {
      return root.redis.evalsha(luaSHA, 3,
        ctx.queueKey, ctx.activeQueueKey, ctx.queueOptionsKey,
        root.count, root.retry, root.expire, root.accuracy, timestamp, +(scanActive !== false)
      )
    })(function (err, res) {
      if (err) throw err
      return new ScanResult(ctx.name, timestamp, res)
    })(done)
  })
}

Queue.prototype.ackjob = function (job) {
  var args = Array.isArray(job) ? job : slice(arguments)
  return thunk.call(this, function (done) {
    for (var i = 0, l = args.length || 1; i < l; i++) validateString(args[i])
    args.unshift(this.activeQueueKey)
    return this.root.redis.hdel(args)(done)
  })
}

Queue.prototype.scan = function () {
  return thunk.call(this, function (done) {
    var ctx = this
    var scores = []
    if (!ctx.listenerCount('job')) throw new Error('"job" listener required!')
    getjobs()

    function getjobs (err, res) {
      if (err) return done(err)
      if (res) {
        res.jobs.map(function (job) {
          if (!job.retryCount) scores.push((job.timing - job.active) / res.retry)
          process.nextTick(function () {
            ctx.emit('job', job)
          })
        })
        if (!res.hasMore) return done(null, scores)
      }
      ctx.getjobs(!res)(getjobs)
    }
  })
}

Queue.prototype.len = function () {
  return thunk.call(this, function (done) {
    return this.root.redis.zcard(this.queueKey)(done)
  })
}

Queue.prototype.showActive = function () {
  return thunk.call(this, function (done) {
    var ctx = this
    return this.root.redis.hgetall(this.activeQueueKey)(function (err, res) {
      if (err) throw err
      return Object.keys(res)
        .map(function (job) {
          var times = res[job].split(':')
          return new Job(ctx.name, job, times[0], times[1], times.length - 2)
        }).sort(function (a, b) {
          return a.timing - b.timing
        })
    })(done)
  })
}

function Job (queue, job, timing, active, retryCount) {
  this.queue = queue
  this.job = job
  this.timing = +timing
  this.active = +active
  this.retryCount = +retryCount
}

function ScanResult (name, timestamp, res) {
  var jobs = res[0]
  this.retry = +res[1]
  this.hasMore = +res[2]
  this.jobs = []
  for (var i = 0, l = jobs.length - 2; i < l; i += 3) {
    this.jobs.push(new Job(name, jobs[i], jobs[i + 1], timestamp, jobs[i + 2]))
  }
}

function slice (args, start) {
  start = start || 0
  if (start >= args.length) return []
  var len = args.length
  var ret = Array(len - start)
  while (len-- > start) ret[len - start] = args[len]
  return ret
}

function validateString (str) {
  if (typeof str !== 'string' || !str) throw new TypeError(String(str) + ' is invalid string')
}
