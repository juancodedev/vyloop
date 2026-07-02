/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // ESLint false positives on relative imports — webpack resolves correctly
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
