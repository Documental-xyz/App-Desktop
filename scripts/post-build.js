#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Enhanced post-build script with comprehensive module fixing and verification
class PostBuildProcessor {
  constructor() {
    this.projectRoot = path.join(__dirname, '..');
    this.distBasePath = path.join(this.projectRoot, 'dist');
    this.sourceModulesPath = path.join(this.projectRoot, 'node_modules');
    this.criticalModules = [
      'sqlite3'
    ];
  }

  getDistPaths() {
    const paths = [];
    
    // Check for different build outputs
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
          paths.push(appPath);
        }
        
        // Also check for direct node_modules (non-ASAR builds)
        const directPath = path.join(buildPath, 'resources', 'app', 'node_modules');
        if (fs.existsSync(directPath)) {
          paths.push(directPath);
        }
      }
    });

    return paths;
  }

  copyModule(moduleName, targetPath) {
    const sourcePath = path.join(this.sourceModulesPath, moduleName);
    const targetModulePath = path.join(targetPath, moduleName);

    if (!fs.existsSync(sourcePath)) {
      console.warn(`⚠️  Source module not found: ${moduleName}`);
      return false;
    }

    try {
      // Remove existing module if it exists
      if (fs.existsSync(targetModulePath)) {
        fs.rmSync(targetModulePath, { recursive: true, force: true });
      }

      // Copy the module
      fs.cpSync(sourcePath, targetModulePath, { recursive: true });
      console.log(`✅ Copied module: ${moduleName}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to copy module ${moduleName}:`, error.message);
      return false;
    }
  }

  verifyModule(moduleName, targetPath) {
    const modulePath = path.join(targetPath, moduleName);
    const packageJsonPath = path.join(modulePath, 'package.json');
    
    return fs.existsSync(modulePath) && fs.existsSync(packageJsonPath);
  }

  checkExecutable(executablePath) {
    try {
      fs.accessSync(executablePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  copyResources(distPath) {
    try {
      const sourceResourcesPath = path.join(this.projectRoot, 'resources');
      const targetResourcesPath = path.join(distPath, '..', '..', 'resources');
      
      if (!fs.existsSync(sourceResourcesPath)) {
        console.warn('⚠️  Source resources directory not found');
        return false;
      }
      
      // Remove existing resources if they exist
      if (fs.existsSync(targetResourcesPath)) {
        fs.rmSync(targetResourcesPath, { recursive: true, force: true });
      }
      
      // Copy resources directory
      fs.cpSync(sourceResourcesPath, targetResourcesPath, { recursive: true });
      console.log('✅ Resources copied successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to copy resources:', error.message);
      return false;
    }
  }

  verifyBuildIntegrity(distPath) {
    console.log('🔍 Verifying build integrity...');
    
    // Determine platform based on path
    const isWindows = distPath.includes('win-unpacked');
    const isLinux = distPath.includes('linux-unpacked') || distPath.includes('AppImage');
    
    const checks = [];
    
    if (isWindows) {
      checks.push(
        {
          name: 'Main executable (Documental.exe)',
          check: () => {
            const executablePath = path.join(distPath, '..', '..', '..', 'Documental.exe');
            return this.checkExecutable(executablePath);
          }
        },
        {
          name: 'ASAR archive exists',
          check: () => {
            const asarPath = path.join(distPath, '..', '..', 'app.asar');
            return fs.existsSync(asarPath);
          }
        }
      );
    }
    
    // Common checks
    checks.push(
      {
        name: 'Critical modules present',
        check: () => {
          return this.criticalModules.every(module => this.verifyModule(module, distPath));
        }
      }
    );
    
    // Only check for package.json in non-ASAR builds
    if (!isWindows && !distPath.includes('asar.unpacked')) {
      checks.push(
        {
          name: 'Package.json exists',
          check: () => {
            const packageJsonPath = path.join(distPath, '..', 'package.json');
            return fs.existsSync(packageJsonPath);
          }
        }
      );
    }

    const results = checks.map(({ name, check }) => {
      try {
        const passed = check();
        console.log(`   ${passed ? '✅' : '❌'} ${name}`);
        return passed;
      } catch (error) {
        console.log(`   ❌ ${name} (Error: ${error.message})`);
        return false;
      }
    });

    return results.every(r => r);
  }

  processBuild() {
    console.log('🚀 Starting post-build processing...');
    
    const distPaths = this.getDistPaths();
    
    if (distPaths.length === 0) {
      console.error('❌ No distribution paths found. Run build first.');
      return false;
    }

    console.log(`📁 Found ${distPaths.length} distribution path(s):`);
    distPaths.forEach((path, index) => console.log(`   ${index + 1}. ${path}`));

    let overallSuccess = true;

    distPaths.forEach((distPath, distIndex) => {
      console.log(`\n🔨 Processing distribution ${distIndex + 1}/${distPaths.length}: ${distPath}`);
      
      // Ensure target directory exists
      if (!fs.existsSync(distPath)) {
        fs.mkdirSync(distPath, { recursive: true });
      }

      // Copy critical modules (native modules that need unpacking)
      console.log('📦 Copying critical modules...');
      this.criticalModules.forEach(moduleName => {
        if (!this.copyModule(moduleName, distPath)) {
          overallSuccess = false;
        }
      });

      // Copy resources (Node.js binaries)
      console.log('🟢 Copying resources...');
      if (!this.copyResources(distPath)) {
        overallSuccess = false;
      }

      // Verify all modules were copied correctly
      console.log('🔍 Verifying copied modules...');
      const verificationResults = this.criticalModules.map(moduleName => ({
        name: moduleName,
        verified: this.verifyModule(moduleName, distPath)
      }));

      const failedVerifications = verificationResults.filter(r => !r.verified);
      if (failedVerifications.length > 0) {
        console.warn(`⚠️  ${failedVerifications.length} modules failed verification:`);
        failedVerifications.forEach(r => console.warn(`   - ${r.name}`));
        overallSuccess = false;
      } else {
        console.log('✅ All modules verified successfully');
      }

      // Verify overall build integrity
      const buildIntegrity = this.verifyBuildIntegrity(distPath);
      if (!buildIntegrity) {
        console.warn('⚠️  Build integrity check failed');
        overallSuccess = false;
      }
    });

    console.log(`\n📊 Post-build processing completed:`);
    console.log(`   ${overallSuccess ? '✅' : '❌'} Overall status: ${overallSuccess ? 'SUCCESS' : 'FAILED'}`);
    
    if (overallSuccess) {
      console.log('🎉 Build is ready for distribution!');
    } else {
      console.log('⚠️  Some issues were detected. Check the logs above.');
    }

    return overallSuccess;
  }
}

// Run the post-build processor
const processor = new PostBuildProcessor();
const success = processor.processBuild();

process.exit(success ? 0 : 1);