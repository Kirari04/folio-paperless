const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Expo SQLite's SDK 57 web worker loads its database engine as a WebAssembly
// asset. Metro does not include `.wasm` in its default asset list.
config.resolver.assetExts.push('wasm');

module.exports = config;
