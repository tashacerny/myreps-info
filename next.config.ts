import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  images: {
    domains: ['theunitedstates.io', 'bioguide.congress.gov'],
  },
}

export default nextConfig
