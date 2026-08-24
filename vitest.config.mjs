/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ' --experimental-require-module';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs}'],
    exclude: ['node_modules', 'dist', '.electron', 'tests/e2e/**', 'tests/*logo*.test.mjs'],
    setupFiles: ['tests/__mocks__/electron-native-resolve.cjs', 'tests/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.test.js',
        '**/*.spec.js',
        'main.js',
        'preload.js'
      ]
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@main': path.resolve(__dirname, './src/main'),
      '@domain': path.resolve(__dirname, './src/domain'),
      '@application': path.resolve(__dirname, './src/application'),
      '@infrastructure': path.resolve(__dirname, './src/infrastructure'),
      // Intercept bare 'electron' (incl. CJS require() inside src/) with the
      // shared stub. vi.mock('electron', factory) still takes precedence per
      // test file. See tests/__mocks__/electron.js.
      electron: fileURLToPath(new URL('./tests/__mocks__/electron.js', import.meta.url))
    }
  }
});