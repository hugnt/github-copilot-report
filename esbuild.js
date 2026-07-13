const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function build() {
    const ctx = await esbuild.context({
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        outfile: './out/extension.js',
        external: ['vscode', 'exceljs'],
        format: 'cjs',
        platform: 'node',
        sourcemap: !production,
        minify: production,
        target: 'node18',
        logLevel: 'info',
        define: {
            'process.env.NODE_ENV': production ? '"production"' : '"development"'
        }
    });

    if (watch) {
        await ctx.watch();
        console.log('Watching for changes...');
    } else {
        await ctx.rebuild();
        await ctx.dispose();
        console.log('Build complete!');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
