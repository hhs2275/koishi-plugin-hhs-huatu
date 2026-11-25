const { test } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { App, Argv, h } = require('koishi')
const { registerNovelai } = require('../src/commands/novelai.ts')
const { registerRedraw } = require('../src/commands/redraw.ts')
const { generateImage } = require('../src/services/generateImage.ts')
const { runPreciseRefInteraction } = require('../src/interactions/preciseRef.ts')
const { settings } = require('../src/services/preciseReferenceV5.ts')
const { MembershipSystem } = require('../src/membershipSystem.ts')
const { QueueSystem } = require('../src/queueSystem.ts')
const { Config } = require('../src/config.ts')

const messageKey = key => `commands.novelai.messages.${key}`
const colors = ['red', 'blue', 'lime', 'teal', 'yellow', 'white']
const file = (color, width = 192, height = 192) =>
  sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
const captions = p => p.director_reference_descriptions.map(x => x.caption.base_caption)

async function fixture(model, params, count, overrides = {}) {
  const files = await Promise.all(colors.slice(0, count).map(color => file(color)))
  const zip = new (require('adm-zip'))()
  zip.addFile('test.png', files[0] || await file('red'))
  const requests = [], refunds = [], deductions = [], log = [], sent = [], downloads = []
  const http = async (_, args) => {
    requests.push(args.data)
    return { data: zip.toBuffer(), headers: new Headers({ 'content-type': 'application/x-zip-compressed' }) }
  }
  http.file = async url => {
    downloads.push(url)
    const match = url.match(/mock-(\d+)\.png$/)
    const data = match ? files[Number(match[1])] : undefined
    if (!data) throw new Error('Reference image unavailable')
    return { data, mime: 'image/png' }
  }
  http.get = async () => ({ tier: 3, active: true, usage: { percent: 90 } })
  const config = Config({ type: 'token', token: 'test', endpoint: 'https://unused.invalid', model,
    membershipEnabled: false, pointsEnabled: true, opusQuotaAllowAnlas: false, imageReviewEnabled: false,
    debugLog: true, maxRetryCount: 0, showQueueInfo: false,
    ...overrides })
  const membershipSystem = {
    config,
    calculatePointsCost: MembershipSystem.prototype.calculatePointsCost,
    isNai5Model: MembershipSystem.prototype.isNai5Model,
    isNai5MediumModel: MembershipSystem.prototype.isNai5MediumModel,
    getNai5UsageWeight: MembershipSystem.prototype.getNai5UsageWeight,
    canUseDrawing: () => true, canUseNai5: () => true, getNai5DailyLimit: () => 0, getNai5OverageCount: () => 0,
    updateLastDrawTime() {}, incrementUsage() {}, releaseNai5Usage() {},
    deductPoints: async (_, amount) => (deductions.push(amount), 100),
    refundPoints: async (_, amount) => refunds.push(amount),
  }
  const runtime = { config, ctx: { http, logger: { info: msg => log.push(msg), warn() {}, error() {}, debug() {} } },
    useFilter: () => () => true, getToken: async () => 'test', thirdParty: () => !['token', 'login'].includes(config.type),
    useBackend: (...types) => () => types.includes(config.type), noImage: () => false, some: () => () => false,
    resolution: value => value, step: Number, tasks: {}, globalTasks: new Set(), userData: {}, membershipSystem }
  const options = { model, preciseRef: true, preciseRefParams: params, sampler: 'k_euler_ancestral', batch: 1, iterations: 1 }
  const images = Array.from({ length: count }, (_, i) => h.image('file:///mock-' + i + '.png'))
  const replies = [images, [h.text('开始')]]
  const s = {
    userId: 'test-user', user: { authority: 5 }, resolve: value => typeof value === 'function' ? value(s) : value,
    text: key => key, channelId: 'test-channel', stripped: { prefix: '', appel: false }, isDirect: true, elements: [],
    send: async value => (sent.push(value), ['test-message']),
    prompt: async callback => replies.length ? callback({ elements: replies.shift() }) : undefined,
  }
  runtime.queueSystem = new QueueSystem(runtime.ctx, config, (session, opts, input) => generateImage(runtime, session, opts, input), membershipSystem)
  return { runtime, s, options, requests, refunds, deductions, http, log, sent, replies, downloads }
}

function commandRunner(f) {
  const app = new App()
  app.plugin((ctx, config) => {
    registerNovelai(ctx, config, f.runtime)
    registerRedraw(ctx, config, f.runtime)
  }, f.runtime.config)
  return (text) => {
    const argv = Argv.parse(text)
    argv.session = f.s
    const command = app.$commander.resolveCommand(argv)
    assert.ok(command, `No command for ${text}`)
    assert.ok(!argv.error, argv.error)
    return command._actions[0](argv, ...argv.args)
  }
}

test('V5 组合与截图开关一致，字母可换序，so/os 不支持', () => {
  for (const pattern of ['sco', 'soc', 'cso', 'cos', 'osc', 'ocs', 'OCS']) {
    assert.deepEqual(settings(`${pattern},2,9`, 1), [{ mode: 'character&style', strength: 2 }])
  }
  for (const [patterns, expected] of [[['sc', 'cs'], 'character&style_anyoutfit'], [['co', 'oc'], 'character_mainoutfit'],
    [['s'], 'style'], [['c'], 'character'], [['o'], 'costume']]) {
    for (const pattern of patterns) assert.deepEqual(settings(pattern, 1), [{ mode: expected, strength: 1 }])
  }
  for (const input of ['so', 'os', 'ss', 'cs-any', 'unknown', 's,-1', 's,5.1', 's,2xx', 's,NaN', 's,Infinity']) {
    assert.equal(settings(input, 1), undefined, input)
  }
})

test('V5 支持中英文标点、末尾分号、按位置补默认，忽略保真度', () => {
  assert.deepEqual(settings('“c，0，99； ; o,5,ignored；”', 4), [
    { mode: 'character', strength: 0 }, { mode: 'character&style', strength: 1 },
    { mode: 'costume', strength: 5 }, { mode: 'character&style', strength: 1 },
  ])
  assert.deepEqual(settings(undefined, 1), [{ mode: 'character&style', strength: 1 }])
  assert.equal(settings('c,1;o,2;', 1), undefined)
})

for (const model of ['nai-v5-full', 'nai-v5-curated']) {
  test(`${model} 为每张参考图发送一条，保留照片和参数顺序`, async () => {
    const f = await fixture(model, 'c,0,9；s，5;o,2;ocs;oc,3;cs,1.5；', 6)
    assert.equal(await runPreciseRefInteraction(f.runtime, f.s, f.options), undefined)
    await generateImage(f.runtime, f.s, f.options, 'test image')
    assert.equal(f.requests.length, 1)
    const { model: id, action, parameters: p } = f.requests[0]
    assert.equal(id, model.replace('v5', 'diffusion-5'))
    assert.equal(action, 'generate')
    assert.equal(p.params_version, 4)
    assert.deepEqual(p.director_reference_strength_values, [0, 5, 2, 1, 3, 1.5])
    assert.deepEqual(p.director_reference_secondary_strength_values, Array(6).fill(0))
    assert.deepEqual(p.director_reference_information_extracted, Array(6).fill(1))
    assert.deepEqual(captions(p), ['character', 'style', 'costume', 'character&style', 'character_mainoutfit', 'character&style_anyoutfit'])
    const expectedColors = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [0, 128, 128], [255, 255, 0], [255, 255, 255]]
    assert.equal(p.director_reference_images.length, colors.length)
    for (const [i, encoded] of p.director_reference_images.entries()) {
      const png = sharp(Buffer.from(encoded, 'base64'))
      const { width, height } = await png.metadata()
      assert.deepEqual([width, height], [1024, 1024])
      const rgb = await png.extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()
      assert.deepEqual([...rgb], expectedColors[i])
      assert.ok(!f.log.some(line => line.includes(encoded)))
    }
  })
}

test('V4.5 保留旧尺寸、强度和保真度换算', async () => {
  const f = await fixture('nai-v4-5-full', 's,0.8,0.25', 1)
  assert.equal(await runPreciseRefInteraction(f.runtime, f.s, f.options), undefined)
  await generateImage(f.runtime, f.s, f.options, 'test image')
  const p = f.requests[0].parameters
  assert.equal(p.params_version, 3)
  assert.deepEqual(captions(p), ['style'])
  assert.deepEqual(p.director_reference_strength_values, [0.8])
  assert.deepEqual(p.director_reference_secondary_strength_values, [0.75])
  assert.equal((await sharp(Buffer.from(p.director_reference_images[0], 'base64')).metadata()).width, 1472)
})

test('从 Koishi 指令入口拦截第三方后端、Medium、V5 局部重绘和非法模式', async () => {
  for (const [type, message, key] of [
    ['sd-webui', 'nai5 test image -P -p "o,2"', 'preciseref-v5-backend'],
    ['token', 'nai5m test image -M -P', 'charref-model-unsupported'],
    ['token', 'nai5c test image -M -P', 'preciseref-v5-inpaint'],
    ['token', 'nai5 test image -P -p "os,2"', 'preciseref-v5-params'],
  ]) {
    const f = await fixture('nai-v5-full', undefined, 0, { type, membershipEnabled: true })
    f.s.prompt = () => assert.fail('不应进入收图流程')
    assert.equal(await commandRunner(f)(message), messageKey(key))
    assert.deepEqual(f.sent, [])
    assert.deepEqual(f.requests, [])
    assert.deepEqual(f.deductions, [])
  }
})

test('失败图片可补发；按成功张数匹配，取消和多余组都不入队', async () => {
  const f = await fixture('nai-v5-full', 'c,2;o,3', 2)
  f.replies.unshift([h.image('file:///missing.png')])
  assert.equal(await runPreciseRefInteraction(f.runtime, f.s, f.options), undefined)
  assert.deepEqual(f.options._preciseRefImages.map(ref => ref.url), ['file:///mock-0.png', 'file:///mock-1.png'])
  for (const [reply, params, expected] of [
    [[h.text('cancel')], '', '已取消精准参考任务。'],
    [null, '-p "c,1;o,2"', messageKey('preciseref-v5-extra-params')],
  ]) {
    const denied = await fixture('nai-v5-full', undefined, 1, { membershipEnabled: true })
    if (reply) denied.replies.splice(1, 1, reply)
    assert.equal(await commandRunner(denied)(`nai5 test image -P ${params}`), expected)
    assert.deepEqual(denied.requests, [])
    assert.deepEqual(denied.deductions, [])
  }
})

test('V5、V4.5 都沿用每张参考图、每张生成结果加 5 点', async () => {
  for (const command of ['nai5', 'nai5c', 'nai4-5']) {
    const f = await fixture('nai-v5-full', undefined, 2, { membershipEnabled: true, maxIterations: 2 })
    const run = commandRunner(f)
    await run(`${command} test image -P -i 2`)
    assert.equal(f.sent[0], messageKey('preciseref-wait-image'), command)
    assert.deepEqual(f.deductions, [20], command)
    assert.equal(f.requests.length, 2, command)
    assert.ok(f.requests.every(r => r.parameters.director_reference_images.length === 2))
    assert.deepEqual(f.refunds, [])
  }
})

test('现有 Opus 额度开关仍只拦截额度耗尽的 V5 任务', async () => {
  for (const [percent, allowAnlas, allowed] of [[90, false, true], [0, false, false], [0, true, true]]) {
    const f = await fixture('nai-v5-full', undefined, 1, { membershipEnabled: true, opusQuotaAllowAnlas: allowAnlas })
    f.http.get = async () => ({ tier: 3, active: true, usage: { percent } })
    const result = await commandRunner(f)('nai5 test image -P')
    assert.deepEqual(f.deductions, [5])
    assert.equal(f.requests.length, Number(allowed))
    assert.deepEqual(f.refunds, allowed ? [] : [5])
    if (!allowed) assert.equal(result, messageKey('opus-quota-exhausted'))
  }
})

test('V5 图生图请求与参考图分离', async () => {
  const f = await fixture('nai-v5-full', 'o,2', 1)
  const original = await file('gold', 416, 608)
  const read = f.http.file
  f.http.file = async url => url === 'file:///original.png' ? { data: original, mime: 'image/png' } : read(url)
  f.options._imageUrls = ['file:///original.png']
  assert.equal(await runPreciseRefInteraction(f.runtime, f.s, f.options), undefined)
  await generateImage(f.runtime, f.s, f.options, 'test image')
  assert.equal(f.requests[0].action, 'img2img')
  assert.deepEqual(captions(f.requests[0].parameters), ['costume'])
  assert.notEqual(f.requests[0].parameters.image, f.requests[0].parameters.director_reference_images[0])
})

test('重画复用上次模式、每任务只重新读取一次，失效时提示并退款', async () => {
  const f = await fixture('nai-v5-full', undefined, 1, { membershipEnabled: true, maxIterations: 2 })
  const run = commandRunner(f)
  await run('nai5 test image -P -p "ocs,2,7" -i 2')
  const saved = f.runtime.queueSystem.getLastTask(f.s.userId).options
  assert.equal(saved._preciseRefImages[0].base64, undefined)
  assert.equal(saved._preciseRefParams, 'ocs,2,7')
  const redraw = async () => {
    const afterRedraw = new Promise(resolve => { f.s.bot = { sendMessage: () => resolve() } })
    await run('重画')
    await afterRedraw
  }
  await redraw()
  assert.equal(f.downloads.length, 2)
  assert.equal(f.requests.length, 4)
  assert.deepEqual(f.requests.slice(2).map(r => captions(r.parameters)), [['character&style'], ['character&style']])
  assert.deepEqual(f.requests[3].parameters.director_reference_strength_values, [2])
  assert.deepEqual(f.deductions, [10, 10])
  f.http.file = async () => { throw new Error('Reference image expired') }
  await redraw()
  assert.equal(f.requests.length, 4)
  assert.ok(f.sent.some(text => typeof text === 'string' && text.includes(messageKey('preciseref-v5-redraw-image'))))
  assert.deepEqual(f.refunds, [10])
})

test('V5 重画竖图按官网尺寸分档并沿用默认参考模式', async () => {
  const f = await fixture('nai-v5-full', undefined, 0)
  const portrait = await file('gold', 416, 608)
  f.http.file = async () => ({ data: portrait, mime: 'image/png' })
  f.options._preciseRefImages = [{ url: 'file:///redraw-reference.png' }]
  await generateImage(f.runtime, f.s, f.options, 'test image')
  const p = f.requests[0].parameters
  assert.deepEqual(captions(p), ['character&style'])
  assert.deepEqual(p.director_reference_strength_values, [1])
  const meta = await sharp(Buffer.from(p.director_reference_images[0], 'base64')).metadata()
  assert.deepEqual([meta.width, meta.height], [832, 1216])
})
