'use strict'

const assert = require('assert')
const Queue = require('bee-queue')
const filter = require('feathers-query-filters')

const QueueLocalEvents = ['ready', 'error', 'succeeded', 'retrying', 'failed', 'stalled']
const QueuePubSubEvents = ['job succeeded', 'job retrying', 'job failed', 'job progress']
const JobEvents = ['succeeded', 'retrying', 'failed', 'progress']
const JobTypes = ['active', 'waiting', 'completed', 'failed', 'delayed']
const CustomEvents = ['queued', 'completed', 'failed']

class QueueService {
  constructor (options) {
    this.options = Object.assign({}, options)
    this.events = options.events || [...CustomEvents]
    this.paginate = options.paginate || {}
    this.queue = {}
  }

  async setup (app) {
    this.app = app
  }

  /**
   * @param params
   * @returns {*}
   */
  find (params) {
    const paginate = (params && typeof params.paginate !== 'undefined') ? params.paginate : this.paginate
    const result = this._find(params, query => filter(query, paginate))

    if (!paginate.default) {
      return result.then(page => page.data)
    }

    return result
  }

  /**
   * @param {Payload} payload
   * @param {feathers.Params & {queue: string, job?:JobOptions}} params
   * @returns {Promise.<Job>}
   */
  create (payload, params) {
    const queue = this.queue[params.queue]
    assert.ok(queue)
    const job = queue.createJob(payload)
    const jobOptions = Object.assign({}, params.job)
    if (!isNaN(jobOptions.retries)) {
      job.retries(jobOptions.retries)
    }
    if (jobOptions.backoff) {
      assert.ok(jobOptions.backoff.strategy)
      assert.ok(jobOptions.backoff.delayFactor)
      job.backoff(jobOptions.backoff.strategy, jobOptions.backoff.delayFactor)
    }
    if (!isNaN(+jobOptions.delayUntil)) {
      job.delayUntil(jobOptions.delayUntil)
    }
    if (!isNaN(jobOptions.timeout)) {
      job.timeout(jobOptions.timeout)
    }
    return job.save()
      .then(job => {
        this.emit('queued', params.queue, job)
        return job
      })
  }

  /**
   * @param {QueueConfig} config
   */
  setupQueue (config) {
    const queue = this.queue[config.name] = new Queue(config.name, config.options)
    if (config.workerClass) {
      queue.process(config.concurrency, (job) => {
        return new config.workerClass(this.app, job).process()
      })
    } else {
      assert.ok(config.processFn)
      queue.process(config.concurrency, config.processFn)
    }
    queue.on('job succeeded', (job, result) => this.emit('completed', job.id, result))
    queue.on('job failed', (job, err) => this.emit('failed', job.id, err))
  }

  /**
   * @param params
   * @param getFilter
   * @returns {Promise.<*>}
   * @private
   */
  async _find (params, getFilter = filter) {
    let { filters } = getFilter(params.query || {})

    if (!params.type) {
      throw new Error('params.type must be specified')
    }

    if (!~JobTypes.indexOf(params.type)) {
      throw new Error('invalid type. valid options are: ' + JobTypes.map(v => '"' + v + '"').join(', '))
    }

    const queue = this.queue[params.queue]
    assert.ok(queue, 'queue ' + params.queue + ' doesn\'t exist')
    const counts = await queue.checkHealth()
    const total = counts[params.type]

    if (filters.$limit === 0) {
      return {
        total,
        limit: filters.$limit,
        skip: filters.$skip || 0,
        data: [],
      }
    }

    const skip = filters.$skip || 0
    const limit = filters.$limit || (total - skip)

    const data = await queue.getJobs(params.type, { start: skip, end: skip + limit })

    return {
      total,
      limit: filters.$limit,
      skip: filters.$skip || 0,
      data,
    }
  }
}

module.exports = options => new QueueService(options)
module.exports.Service = QueueService
