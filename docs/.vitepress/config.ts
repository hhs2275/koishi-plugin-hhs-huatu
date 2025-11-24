import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'HHS绘图插件',
  description: 'NovelAI 增强版 - 基于 novelai-bot 二次开发',
  base: '/',
  
  themeConfig: {
    logo: '/logo.png',
    
    nav: [
      { text: '首页', link: '/' },
      { text: '指南', link: '/guide/getting-started' },
      { text: '功能', link: '/guide/features' },
      { text: '常见问题', link: '/guide/faq' },
      { 
        text: '社区', 
        items: [
          { text: 'QQ交流群', link: 'https://qm.qq.com/q/4nKKvckKbu' },
          { text: 'GitHub', link: 'https://github.com/koishijs/koishi-plugin-novelai' }
        ]
      }
    ],

    sidebar: {
      '/guide/': [
        {
          text: '开始使用',
          items: [
            { text: '快速开始', link: '/guide/getting-started' },
            { text: '基础指令', link: '/guide/basic-commands' },
            { text: '功能介绍', link: '/guide/features' }
          ]
        },
        {
          text: '核心功能',
          items: [
            { text: '角色提示词', link: '/guide/characters' },
            { text: '会员系统', link: '/guide/membership' },
            { text: '图片审核', link: '/guide/audit' },
            { text: '队列系统', link: '/guide/queue' }
          ]
        },
        {
          text: '高级配置',
          items: [
            { text: '配置选项', link: '/guide/config' },
            { text: '腾讯云审核', link: '/guide/tencent-audit' }
          ]
        },
        {
          text: '其他',
          items: [
            { text: '常见问题', link: '/guide/faq' },
            { text: '更新日志', link: '/guide/changelog' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/koishijs/koishi-plugin-novelai' }
    ],

    footer: {
      message: '基于 novelai-bot 项目开发',
      copyright: 'Copyright © 2024 | MIT License'
    },

    search: {
      provider: 'local'
    },

    editLink: {
      pattern: 'https://github.com/koishijs/koishi-plugin-novelai/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页'
    },

    lastUpdated: {
      text: '最后更新',
      formatOptions: {
        dateStyle: 'short',
        timeStyle: 'short'
      }
    }
  },

  markdown: {
    lineNumbers: true
  }
})

