const { test } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { h } = require('koishi')
const { generateImage } = require('../src/services/generateImage.ts')
const { runPreciseRefInteraction } = require('../src/interactions/preciseRef.ts')
const { Config } = require('../src/config.ts')

async function fixture(model, params, count) {
  const img = await sharp({ create: { width: 192, height: 192, channels: 3, background: 'teal' } }).png().toBuffer()
  const zip = new (require('adm-zip'))()
  zip.addFile('test.png', img)
  const requests = [], refunds = [], log = []
  const http = async (_, args) => {
    requests.push(args.data)
    return { data: zip.toBuffer(), headers: new Headers({ 'content-type': 'application/x-zip-compressed' }) }
  }
  http.file = async () => ({ data: img, mime: 'image/png' })
  const config = Config({ type: 'token', token: 'test', model, membershipEnabled: false, pointsEnabled: true,
    opusQuotaAllowAnlas: true, imageReviewEnabled: false, debugLog: true, maxRetryCount: 0 })
  const runtime = { config, ctx: { http, logger: { info: msg => log.push(msg), warn() {}, error() {}, debug() {} } },
    useFilter: () => () => true, getToken: async () => 'test', tasks: {}, globalTasks: new Set(),
    membershipSystem: { releaseNai5Usage() {}, refundPoints: async (_, amount) => refunds.push(amount) } }
  const options = { model, preciseRef: true, preciseRefParams: params, sampler: 'k_euler_ancestral', batch: 1, iterations: 1 }
  const images = Array.from({ length: count }, (_, i) => h.image('file:///mock-' + i + '.png'))
  const replies = [images, [h.text('开始')]]
  const s = {
    userId: 'test-user', user: { authority: 5 }, resolve: value => value, text: key => key,
    send: async () => ['test-message'], prompt: async callback => callback({ elements: replies.shift() }),
  }
  return { runtime, s, options, requests, refunds, http, log }
}

for (const model of ['nai-v5-full', 'nai-v5-curated']) {
  test(model + ' 按收图顺序构造 V5 精准参考请求', async () => {
    const f = await fixture(model, 'c,0,0.4；s，5;o,2;cs;co,3;cs-any,1.5', 6)
    assert.equal(await runPreciseRefInteraction(f.runtime, f.s, f.options), undefined)
    await generateImage(f.runtime, f.s, f.options, 'test image')
    assert.equal(f.requests.length, 1)
    const { model: id, action, parameters: p } = f.requests[0]
    assert.equal(id, model.replace('v5', 'diffusion-5'))
    assert.equal(action, 'generate')
    assert.deepEqual(p.director_reference_strength_values, [0, 5, 2, 1, 3, 1.5])
    assert.deepEqual(p.director_reference_secondary_strength_values, Array(6).fill(0))
    assert.deepEqual(p.director_reference_information_extracted, Array(6).fill(1))
    assert.deepEqual(p.director_reference_descriptions.map(x => x.caption.base_caption),
      ['character', 'style', 'costume', 'character&style', 'character_mainoutfit', 'character&style_anyoutfit'])
    assert.equal(p.director_reference_images.length, 6)
    const meta = await sharp(Buffer.from(p.director_reference_images[0], 'base64')).metadata()
    assert.deepEqual([meta.width, meta.height], [1024, 1024])
    assert.ok(!f.log.some(line => line.includes(p.director_reference_images[0])))
  })
}

test('V4.5 保留原有的图片尺寸、强度与保真度换算', async () => {
  const f = await fixture('nai-v4-5-full', 's,0.8,0.25', 1)
  assert.equal(await runPreciseRefInteraction(f.runtime, f.s, f.options), undefined)
  await generateImage(f.runtime, f.s, f.options, 'test image')
  const p = f.requests[0].parameters
  assert.equal(p.director_reference_descriptions[0].caption.base_caption, 'style')
  assert.deepEqual(p.director_reference_strength_values, [0.8])
  assert.deepEqual(p.director_reference_secondary_strength_values, [0.75])
  assert.equal((await sharp(Buffer.from(p.director_reference_images[0], 'base64')).metadata()).width, 1472)
})

test('不支持的模型和无效参数会在收图前返回，多余参数组会在入队前返回', async () => {
  for (const [model, params, message] of [
    ['nai-v5-full', 's,5.1', 'preciseref-v5-params'], ['nai-v5-full', 'unknown', 'preciseref-v5-params'],
    ['nai-v4-full', 's,1', 'charref-model-unsupported'],
  ]) {
    const f = await fixture(model, params, 1)
    f.s.prompt = () => assert.fail('不应进入收图流程')
    assert.equal(await runPreciseRefInteraction(f.runtime, f.s, f.options), 'commands.novelai.messages.' + message)
    assert.equal(f.requests.length, 0)
  }
  const f = await fixture('nai-v5-full', 'c,1;o,2', 1)
  assert.match(await runPreciseRefInteraction(f.runtime, f.s, f.options), /preciseref-v5-params$/)
  assert.equal(f.options._preciseRefImages, undefined)
})

test('重画时参考图失效会终止请求并退还点数', async () => {
  const f = await fixture('nai-v5-full', 'c,1;o,2', 2)
  assert.equal(await runPreciseRefInteraction(f.runtime, f.s, f.options), undefined)
  delete f.options._preciseRefImages[1].base64
  f.http.file = async () => { throw Error('参考图已失效') }
  f.options._deductedPoints = 10
  await generateImage(f.runtime, f.s, f.options, 'test image')
  assert.equal(f.requests.length, 0)
  assert.deepEqual(f.refunds, [10])
})

test('重画时从原地址重建竖版参考图，并保留默认模式与强度', async () => {
  const f = await fixture('nai-v5-full', undefined, 1)
  const portrait = await sharp({ create: { width: 416, height: 608, channels: 3, background: 'gold' } }).png().toBuffer()
  let downloads = 0
  f.http.file = async url => {
    assert.equal(url, 'file:///redraw-reference.png')
    downloads++
    return { data: portrait, mime: 'image/png' }
  }
  f.options._preciseRefImages = [{ url: 'file:///redraw-reference.png' }]
  await generateImage(f.runtime, f.s, f.options, 'test image')
  assert.equal(downloads, 1)
  const p = f.requests[0].parameters
  assert.equal(p.director_reference_descriptions[0].caption.base_caption, 'character&style')
  assert.deepEqual(p.director_reference_strength_values, [1])
  const meta = await sharp(Buffer.from(p.director_reference_images[0], 'base64')).metadata()
  assert.deepEqual([meta.width, meta.height], [832, 1216])
})
