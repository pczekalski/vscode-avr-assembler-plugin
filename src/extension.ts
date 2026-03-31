import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type RunResult = {
    code: number | null;
    signal: NodeJS.Signals | null;
};

function runCommand(
    command: string,
    args: string[],
    cwd: string,
    output: vscode.OutputChannel
): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        output.appendLine(`> ${command} ${args.join(' ')}`);

        const child = spawn(command, args, {
            cwd,
            shell: false
        });

        child.stdout.on('data', (data: Buffer) => {
            output.append(data.toString());
        });

        child.stderr.on('data', (data: Buffer) => {
            output.append(data.toString());
        });

        child.on('error', (err: Error) => {
            reject(err);
        });

        child.on('close', (code, signal) => {
            resolve({ code, signal });
        });
    });
}

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('AVR ASM Builder');

    const disposable = vscode.commands.registerCommand(
        'avr-asm-builder.buildCurrentFile',
        async () => {
            try {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage('No active editor.');
                    return;
                }

                const doc = editor.document;
                if (doc.isUntitled) {
                    vscode.window.showErrorMessage('Please save the file first.');
                    return;
                }

                const sourceFile = doc.fileName;
                const ext = path.extname(sourceFile).toLowerCase();

                if (ext !== '.s') {
                    vscode.window.showErrorMessage('This command only supports .s files.');
                    return;
                }

                if (!fs.existsSync(sourceFile)) {
                    vscode.window.showErrorMessage('Source file does not exist.');
                    return;
                }

                await doc.save();

                const config = vscode.workspace.getConfiguration('avr-asm-builder');
                const mcu = config.get<string>('mcu', 'atmega328p');
                const avrGcc = config.get<string>('avrGccPath', 'avr-gcc');
                const avrObjcopy = config.get<string>('avrObjcopyPath', 'avr-objcopy');
                const outputDirectoryName = config.get<string>('outputDirectory', 'build');

                const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
                const baseDir = workspaceFolder?.uri.fsPath ?? path.dirname(sourceFile);
                const buildDir = path.resolve(baseDir, outputDirectoryName);

                fs.mkdirSync(buildDir, { recursive: true });

                const baseName = path.basename(sourceFile, '.s');
                const objectFile = path.join(buildDir, `${baseName}.o`);
                const elfFile = path.join(buildDir, `${baseName}.elf`);
                const hexFile = path.join(buildDir, `${baseName}.hex`);

                output.clear();
                output.show(true);
                output.appendLine(`Source : ${sourceFile}`);
                output.appendLine(`Build  : ${buildDir}`);
                output.appendLine(`MCU    : ${mcu}`);
                output.appendLine('');

                // Step 1: assemble .s -> .o
                const assembleArgs = [
                    '-mmcu=' + mcu,
                    '-c',
                    sourceFile,
                    '-o',
                    objectFile
                ];

                const assembleResult = await runCommand(avrGcc, assembleArgs, baseDir, output);
                if (assembleResult.code !== 0) {
                    vscode.window.showErrorMessage(`Assembling failed with exit code ${assembleResult.code}.`);
                    output.appendLine('\nBuild stopped at assemble stage.');
                    return;
                }

                // Step 2: link .o -> .elf
                const linkArgs = [
                    '-mmcu=' + mcu,
                    objectFile,
                    '-o',
                    elfFile
                ];

                const linkResult = await runCommand(avrGcc, linkArgs, baseDir, output);
                if (linkResult.code !== 0) {
                    vscode.window.showErrorMessage(`Linking failed with exit code ${linkResult.code}.`);
                    output.appendLine('\nBuild stopped at link stage.');
                    return;
                }

                // Step 3: convert .elf -> .hex
                const objcopyArgs = [
                    '-O',
                    'ihex',
                    '-R',
                    '.eeprom',
                    elfFile,
                    hexFile
                ];

                const objcopyResult = await runCommand(avrObjcopy, objcopyArgs, baseDir, output);
                if (objcopyResult.code !== 0) {
                    vscode.window.showErrorMessage(`HEX conversion failed with exit code ${objcopyResult.code}.`);
                    output.appendLine('\nBuild stopped at objcopy stage.');
                    return;
                }

                output.appendLine('\nBuild successful.');
                output.appendLine(`Generated:`);
                output.appendLine(`  ${objectFile}`);
                output.appendLine(`  ${elfFile}`);
                output.appendLine(`  ${hexFile}`);

                vscode.window.showInformationMessage(`AVR build successful: ${path.basename(hexFile)}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Build failed: ${message}`);
                output.show(true);
                output.appendLine(`\nERROR: ${message}`);
            }
        }
    );

    context.subscriptions.push(disposable, output);
}

export function deactivate() {}