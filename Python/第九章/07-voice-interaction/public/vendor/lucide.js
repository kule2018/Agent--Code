/**
 * 本页面使用的 Lucide 1.53.0 五个图标，非完整 SDK。
 * 图标路径来自官方包，独立保存在本节，不需要 Node、npm 或网络 CDN。
 * Copyright (c) 2026 Lucide Icons and Contributors. ISC License，见 LICENSE.txt。
 * createIcons 保留页面使用的接口；渲染器仅负责这五个固定图标。
 */
(() => {
  const icons = {
    'audio-lines': [
      ['path', { d: 'M2 10v3' }], ['path', { d: 'M6 6v11' }],
      ['path', { d: 'M10 3v18' }], ['path', { d: 'M14 8v7' }],
      ['path', { d: 'M18 5v13' }], ['path', { d: 'M22 10v3' }]
    ],
    'file-input': [
      ['path', { d: 'M4 11V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1' }],
      ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
      ['path', { d: 'M2 15h10' }], ['path', { d: 'm9 18 3-3-3-3' }]
    ],
    mic: [
      ['path', { d: 'M12 19v3' }], ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }],
      ['rect', { x: '9', y: '2', width: '6', height: '13', rx: '3' }]
    ],
    send: [
      ['path', { d: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z' }],
      ['path', { d: 'm21.854 2.147-10.94 10.939' }]
    ],
    'volume-2': [
      ['path', { d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z' }],
      ['path', { d: 'M16 9a5 5 0 0 1 0 6' }],
      ['path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }]
    ]
  }
  const namespace = 'http://www.w3.org/2000/svg'
  window.lucide = {
    createIcons() {
      for (const node of document.querySelectorAll('[data-lucide]')) {
        const name = node.getAttribute('data-lucide')
        if (!icons[name]) continue
        const svg = document.createElementNS(namespace, 'svg')
        for (const [key, value] of Object.entries({
          width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round',
          'stroke-linejoin': 'round', 'aria-hidden': 'true',
          class: `lucide lucide-${name}`
        })) svg.setAttribute(key, value)
        for (const [tag, attributes] of icons[name]) {
          const element = document.createElementNS(namespace, tag)
          for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
          svg.append(element)
        }
        node.replaceWith(svg)
      }
    }
  }
})()
