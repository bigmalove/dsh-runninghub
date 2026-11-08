import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// 正文成片宽度：插件只给自己的媒体（data-owner 含 runninghub）注入样式，
// 把 Tavern 的 min(100%,640px) + 70vh(70svh) 两道上限解开，宽度交回正文列宽。
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

test('正文媒体样式：按插件 owner 作用域注入，不动别人的插图', () => {
  assert.match(source, /const CHAT_MEDIA_STYLE_ID = 'dsh-runninghub\/chat-media\.css'/)
  const selectors = source.match(/\.dsh-tavern-plugin-media\[data-owner\*="runninghub" i\][^{]*\{/g) || []
  assert.ok(selectors.length >= 4, '图片、链接、视频、说明各有一条规则，实际 ' + selectors.length)
  for (const selector of selectors) {
    assert.match(selector, /data-owner/, '每条规则都必须带 owner 限定，避免影响其它插件的插图')
  }
  assert.doesNotMatch(source, /\.dsh-tavern-plugin-media\{[^}]*width:100%/, '不能无条件放宽所有插件媒体')
})

test('正文媒体样式：图片按列宽铺满且不再按视口高度收窄', () => {
  const image = /\.dsh-tavern-plugin-media\[data-owner\*="runninghub" i\] img\{([^}]*)\}/.exec(source)
  assert.ok(image, '缺少图片规则')
  const body = image[1]
  assert.match(body, /width:100%/, '宽度要跟随正文列宽')
  assert.match(body, /height:auto/, '保持原始比例')
  assert.match(body, /max-height:none/, '不能再用 70vh 把宽度一起压小')
  assert.match(body, /object-fit:contain/)
})

test('正文媒体样式：容器改成块级，避免 flex-start 下的宽度循环', () => {
  const figure = /\.dsh-tavern-plugin-media\[data-owner\*="runninghub" i\]\{([^}]*)\}/.exec(source)
  assert.ok(figure, '缺少容器规则')
  assert.match(figure[1], /display:block/)
  assert.match(figure[1], /max-width:100%/)
  const link = /\.dsh-tavern-plugin-media\[data-owner\*="runninghub" i\]>a\{([^}]*)\}/.exec(source)
  assert.ok(link, '缺少图片链接规则')
  assert.match(link[1], /width:100%/)
})

test('正文媒体样式：apply 时注入一次，且可重复调用不重复插入', () => {
  assert.match(source, /try \{ installChatMediaCss\(\) \} catch/)
  assert.match(source, /document\.head\.querySelector\(selector\)/)
  assert.match(source, /if \(style\.textContent !== chatMediaCss\) style\.textContent = chatMediaCss/)
})
