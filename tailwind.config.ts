import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        civic: {
          navy: '#1e3a5f',
          blue: '#2563eb',
          light: '#eff6ff',
          border: '#dbeafe',
        },
        party: {
          democrat: '#1a56db',
          republican: '#c0392b',
          independent: '#6b7280',
          green: '#15803d',
          libertarian: '#d97706',
        },
        vote: {
          yea: '#15803d',
          nay: '#c0392b',
          abstain: '#6b7280',
          absent: '#9ca3af',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

export default config
