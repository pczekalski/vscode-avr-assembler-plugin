import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type RunResult = {
    code: number | null;
};

function runCommand(
    command: string,
    args: string[],
    cwd: string,
    output: vscode.OutputChannel
): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        output.appendLine(`> ${command} ${args.join(' ')}`);

        const child = spawn(command, args, { cwd, shell: false });

        child.stdout.on('data', (d) => output.append(d.toString()));
        child.stderr.on('data', (d) => output.append(d.toString()));

        child.on('error', (err) => reject(err));
        child.on('close', (code) => resolve({ code }));
    });
}

function getPaths(doc: vscode.TextDocument) {
    const source = doc.fileName;

    const workspace = vscode.workspace.getWorkspaceFolder(doc.uri);
    const baseDir = workspace?.uri.fsPath ?? path.dirname(source);

    const config = vscode.workspace.getConfiguration('avr-asm-builder');
    const buildDir = path.join(baseDir, config.get<string>('outputDirectory', 'build'));

    fs.mkdirSync(buildDir, { recursive: true });

    const name = path.basename(source, '.s');

    return {
        source,
        baseDir,
        buildDir,
        object: path.join(buildDir, name + '.o'),
        elf: path.join(buildDir, name + '.elf'),
        hex: path.join(buildDir, name + '.hex')
    };
}

async function build(output: vscode.OutputChannel) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
    }

    const doc = editor.document;

    if (doc.isUntitled) {
        vscode.window.showErrorMessage('Save file first');
        return;
    }

    if (!doc.fileName.endsWith('.s')) {
        vscode.window.showErrorMessage('Only .s files supported');
        return;
    }

    await doc.save();

    const config = vscode.workspace.getConfiguration('avr-asm-builder');

    const mcu = config.get<string>('mcu', 'atmega328p');
    const avrGcc = config.get<string>('avrGccPath', 'avr-gcc');
    const avrObjcopy = config.get<string>('avrObjcopyPath', 'avr-objcopy');
    const avrSize = config.get<string>('avrSizePath', 'avr-size');
    const useNoStartFiles = config.get<boolean>('useNoStartFiles', true);

    const p = getPaths(doc);

    output.clear();
    output.show(true);

    output.appendLine(`Source : ${p.source}`);
    output.appendLine(`Build  : ${p.buildDir}`);
    output.appendLine(`MCU    : ${mcu}`);
    output.appendLine(`useNoStartFiles = ${useNoStartFiles}`);
    output.appendLine('');

    // --- assemble ---
    let r = await runCommand(
        avrGcc,
        ['-mmcu=' + mcu, '-c', p.source, '-o', p.object],
        p.baseDir,
        output
    );

    if (r.code !== 0) {
        output.appendLine('\nFAILED at assemble');
        return;
    }

    // --- link ---
    const linkArgs = useNoStartFiles
        ? ['-mmcu=' + mcu, '-nostartfiles', p.object, '-o', p.elf]
        : ['-mmcu=' + mcu, p.object, '-o', p.elf];

    r = await runCommand(avrGcc, linkArgs, p.baseDir, output);

    if (r.code !== 0) {
        output.appendLine('\nFAILED at link');
        return;
    }

    // --- objcopy ---
    r = await runCommand(
        avrObjcopy,
        ['-O', 'ihex', '-R', '.eeprom', p.elf, p.hex],
        p.baseDir,
        output
    );

    if (r.code !== 0) {
        output.appendLine('\nFAILED at objcopy');
        return;
    }

    // --- size ---
    output.appendLine('\nSIZE:');
    await runCommand(avrSize, [p.elf], p.baseDir, output);

    output.appendLine('\nBUILD OK');
    vscode.window.showInformationMessage('Build OK');
}

async function upload(output: vscode.OutputChannel) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;

    const config = vscode.workspace.getConfiguration('avr-asm-builder');

    const avrdude = config.get<string>('avrdudePath', 'avrdude');
    const programmer = config.get<string>('avrdudeProgrammer', 'arduino');
    const port = config.get<string>('avrdudePort', '/dev/ttyUSB0');
    const baud = config.get<number>('avrdudeBaud', 115200);
    const mcu = config.get<string>('mcu', 'atmega328p');

    const p = getPaths(doc);

    if (!fs.existsSync(p.hex)) {
        vscode.window.showErrorMessage('HEX not found. Build first.');
        return;
    }

    output.clear();
    output.show(true);

    let args = [
        '-c', programmer,
        '-p', mcu,
        '-P', port,
        '-b', String(baud),
        '-D',
        '-U', `flash:w:${p.hex}:i`
    ];

    let r = await runCommand(avrdude, args, p.baseDir, output);

    if (r.code !== 0) {
        output.appendLine('\nUPLOAD FAILED');
        return;
    }

    output.appendLine('\nUPLOAD OK');
    vscode.window.showInformationMessage('Upload OK');
}

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('AVR ASM Builder');

    const buildCmd = vscode.commands.registerCommand(
        'avr-asm-builder.buildCurrentFile',
        () => build(output)
    );

    const uploadCmd = vscode.commands.registerCommand(
        'avr-asm-builder.uploadCurrentHex',
        () => upload(output)
    );

    // --- STATUS BAR ---
    const buildBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    buildBtn.text = '$(tools) AVR Build';
    buildBtn.command = 'avr-asm-builder.buildCurrentFile';

    const uploadBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    uploadBtn.text = '$(arrow-up) AVR Upload';
    uploadBtn.command = 'avr-asm-builder.uploadCurrentHex';
    setTimeout(()=> {
        buildBtn.show();
        uploadBtn.show();
    }, 100);

    context.subscriptions.push(buildCmd, uploadCmd, buildBtn, uploadBtn, output);
}

export function deactivate() {}