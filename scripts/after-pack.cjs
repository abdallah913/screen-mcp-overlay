/**
 * electron-builder afterPack hook: brand the packaged executable.
 *
 * The build sets `win.signAndEditExecutable: false` because electron-builder's
 * winCodeSign bundle contains macOS symlinks that cannot be extracted on
 * Windows without Developer Mode or an elevated shell, which kills the build on
 * a stock machine. Turning it off skips signing (we have no certificate anyway)
 * but also skips rcedit, so the exe would keep Electron's icon and version
 * strings. Running rcedit here brands it before the installer and portable
 * targets wrap it up.
 */

const { join } = require('node:path');

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') return;

    const root = join(__dirname, '..');
    const pkg = require(join(root, 'package.json'));
    const productName = pkg.build.productName;
    const exePath = join(context.appOutDir, `${productName}.exe`);

    // rcedit is ESM-only and this hook must be CommonJS for electron-builder.
    const { rcedit } = await import('rcedit');

    await rcedit(exePath, {
        icon: join(root, 'build', 'icon.ico'),
        'file-version': pkg.version,
        'product-version': pkg.version,
        'version-string': {
            ProductName: productName,
            FileDescription: pkg.description,
            CompanyName: pkg.author && pkg.author.name ? pkg.author.name : '',
            LegalCopyright: `Copyright (c) ${new Date().getFullYear()}`,
            OriginalFilename: `${productName}.exe`
        }
    });

    console.log(`  • branded executable  file=${productName}.exe version=${pkg.version}`);
};
