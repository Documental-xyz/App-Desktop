#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Build verification script to ensure all dependencies are correctly packaged
class BuildVerifier {
  constructor() {
    this.projectRoot = path.join(__dirname, '..');
    this.distBasePath = path.join(this.projectRoot, 'dist');
    this.criticalModules = [
      'sqlite3'
    ];
  }

  getDistPaths() {
    const paths = [];
    
    const builds = [
      'linux-unpacked',
      'AppImage',
      'deb',
      'snap',
      'win-unpacked'
    ];

    builds.forEach(build => {
      const buildPath = path.join(this.distBasePath, build);
      if (fs.existsSync(buildPath)) {
        const appPath = path.join(buildPath, 'resources', 'app.asar.unpacked', 'node_modules');
        if (fs.existsSync(appPath)) {
          paths.push({ type: 'asar-unpacked', path: appPath, build });
        }
        
        const directPath = path.join(buildPath, 'resources', 'app', 'node_modules');
        if (fs.existsSync(directPath)) {
          paths.push({ type: 'direct', path: directPath, build });
        }
      }
    });

    return paths;
  }

  checkModule(moduleName, nodeModulesPath) {
    const modulePath = path.join(nodeModulesPath, moduleName);
    const packageJsonPath = path.join(modulePath, 'package.json');
    
    if (!fs.existsSync(modulePath)) {
      return { exists: false, reason: 'Module directory not found' };
    }
    
    if (!fs.existsSync(packageJsonPath)) {
      return { exists: false, reason: 'package.json not found' };
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return { 
        exists: true, 
        version: packageJson.version,
        name: packageJson.name
      };
    } catch (error) {
      return { exists: false, reason: `Invalid package.json: ${error.message}` };
    }
  }

  checkExecutable(buildPath) {
    const executableName = process.platform === 'win32' ? 'app-git-electron.exe' : 'app-git-electron';
    const executablePath = path.join(buildPath, executableName);
    
    return {
      exists: fs.existsSync(executablePath),
      path: executablePath
    };
  }

  checkMainFiles(buildPath) {
    const checks = [
      { name: 'main.js', path: path.join(buildPath, 'resources', 'app', 'main.js') },
      { name: 'preload.js', path: path.join(buildPath, 'resources', 'app', 'preload.js') },
      { name: 'package.json', path: path.join(buildPath, 'resources', 'app', 'package.json') },
      { name: 'renderer/index.html', path: path.join(buildPath, 'resources', 'app', 'renderer', 'index.html') }
    ];

    // First check if files exist directly (for non-ASAR builds)
    const directChecks = checks.map(check => ({
      name: check.name,
      exists: fs.existsSync(check.path)
    }));

    // If direct checks fail, check in ASAR
    if (directChecks.some(check => !check.exists)) {
      const asarPath = path.join(buildPath, 'resources', 'app.asar');
      if (fs.existsSync(asarPath)) {
        try {
          const asar = require('asar');
          const asarFiles = asar.listFile(asarPath);
          
          return checks.map(check => ({
            name: check.name,
            exists: asarFiles.some(file => file.endsWith(check.name))
          }));
        } catch (error) {
          console.warn('Could not check ASAR contents:', error.message);
          return directChecks;
        }
      }
    }

    return directChecks;
  }

  verifyBuild() {
    console.log('🔍 Starting build verification...\n');
    
    const distPaths = this.getDistPaths();
    
    if (distPaths.length === 0) {
      console.error('❌ No distribution paths found. Run build first.');
      return false;
    }

    console.log(`📁 Found ${distPaths.length} distribution(s):`);
    distPaths.forEach((dist, index) => {
      console.log(`   ${index + 1}. ${dist.build} (${dist.type})`);
    });

    let overallSuccess = true;

    distPaths.forEach((distInfo, distIndex) => {
      console.log(`\n🔨 Verifying build ${distIndex + 1}/${distPaths.length}: ${distInfo.build}`);
      console.log(`   Type: ${distInfo.type}`);
      console.log(`   Path: ${distInfo.path}`);
      
      // Check critical modules
      console.log('\n📦 Checking critical modules:');
      const moduleResults = this.criticalModules.map(moduleName => {
        const result = this.checkModule(moduleName, distInfo.path);
        const status = result.exists ? '✅' : '❌';
        const version = result.version ? ` (v${result.version})` : '';
        const reason = result.reason ? ` - ${result.reason}` : '';
        console.log(`   ${status} ${moduleName}${version}${reason}`);
        return result.exists;
      });

      const missingModules = moduleResults.filter(r => !r).length;
      if (missingModules > 0) {
        console.warn(`⚠️  ${missingModules} critical modules are missing or broken`);
        overallSuccess = false;
      } else {
        console.log('✅ All critical modules are present and valid');
      }

      // Check executable and main files
      const buildPath = path.join(this.distBasePath, distInfo.build);
      console.log('\n🔧 Checking build integrity:');
      
      const executable = this.checkExecutable(buildPath);
      console.log(`   ${executable.exists ? '✅' : '❌'} Executable: ${path.basename(executable.path)}`);
      
      const mainFiles = this.checkMainFiles(buildPath);
      mainFiles.forEach(file => {
        console.log(`   ${file.exists ? '✅' : '❌'} ${file.name}`);
      });

      const allFilesPresent = executable.exists && mainFiles.every(f => f.exists);
      if (!allFilesPresent) {
        console.warn('⚠️  Some essential files are missing');
        overallSuccess = false;
      } else {
        console.log('✅ All essential files are present');
      }

      // Check ASAR integrity if applicable
      if (distInfo.type === 'asar-unpacked') {
        const asarPath = path.join(buildPath, 'resources', 'app.asar');
        if (fs.existsSync(asarPath)) {
          console.log(`   ✅ ASAR archive exists (${Math.round(fs.statSync(asarPath).size / 1024 / 1024)}MB)`);
        } else {
          console.log('   ⚠️  ASAR archive not found (might be expected for some builds)');
        }
      }
    });

    console.log(`\n📊 Verification Summary:`);
    console.log(`   ${overallSuccess ? '✅' : '❌'} Overall status: ${overallSuccess ? 'PASS' : 'FAIL'}`);
    
    if (overallSuccess) {
      console.log('🎉 Build verification passed! Ready for distribution.');
    } else {
      console.log('❌ Build verification failed. Fix the issues before distribution.');
    }

    return overallSuccess;
  }
}

// Run the verifier
const verifier = new BuildVerifier();
const success = verifier.verifyBuild();

process.exit(success ? 0 : 1);