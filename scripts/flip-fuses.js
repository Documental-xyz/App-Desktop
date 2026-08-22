'use strict';

/**
 * electron-builder afterPack hook — flips Electron fuses on the packaged
 * binary before code signing.
 *
 * Embedded Node migration: RunAsNode MUST stay enabled so the app binary
 * can be spawned with ELECTRON_RUN_AS_NODE=1 to run bundled npm-cli.js.
 */

const path = require('path');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = async function flipFusesHook(context) {
  const name = context.packager.executableName || context.packager.appInfo.productFilename;
  const ext = context.electronPlatformName === 'win32' ? '.exe' : '';
  const appPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${name}.app`)
    : path.join(context.appOutDir, `${name}${ext}`);
  await flipFuses(appPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: true,
    // Remaining fuses keep stock Electron defaults (preserve current state).
    [FuseV1Options.EnableCookieEncryption]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true,
    [FuseV1Options.EnableNodeCliInspectArguments]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
};
