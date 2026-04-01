import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type RunResult = {
    code: number | null;
    stdout: string;
    stderr: string;
};

type BuildPaths = {
    source: string;
    baseDir: string;
    buildDir: string;
    object: string;
    elf: string;
    hex: string;
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

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: Buffer | string) => {
            const text = data.toString();
            stdout += text;
            output.append(text);
        });

        child.stderr.on('data', (data: Buffer | string) => {
            const text = data.toString();
            stderr += text;
            output.append(text);
        });

        child.on('error', (err: Error) => {
            reject(err);
        });

        child.on('close', (code) => {
            resolve({
                code,
                stdout,
                stderr
            });
        });
    });
}

function getActiveDocument(): vscode.TextDocument | undefined {
    return vscode.window.activeTextEditor?.document;
}

function validateDocument(doc: vscode.TextDocument): string | undefined {
    if (doc.isUntitled) {
        return 'Please save the file first.';
    }

    if (path.extname(doc.fileName).toLowerCase() !== '.s') {
        return 'This command only supports .s files.';
    }

    if (!fs.existsSync(doc.fileName)) {
        return 'Source file does not exist on disk.';
    }

    return undefined;
}

function getPaths(doc: vscode.TextDocument): BuildPaths {
    const source = doc.fileName;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const baseDir = workspaceFolder?.uri.fsPath ?? path.dirname(source);

    const config = vscode.workspace.getConfiguration('avr-asm-builder');
    const outputDirectory = config.get<string>('outputDirectory', 'build');
    const buildDir = path.resolve(baseDir, outputDirectory);

    fs.mkdirSync(buildDir, { recursive: true });

    const baseName = path.basename(source, '.s');

    return {
        source,
        baseDir,
        buildDir,
        object: path.join(buildDir, `${baseName}.o`),
        elf: path.join(buildDir, `${baseName}.elf`),
        hex: path.join(buildDir, `${baseName}.hex`)
    };
}

function severityFromText(kind: string): vscode.DiagnosticSeverity {
    switch (kind.toLowerCase()) {
        case 'warning':
            return vscode.DiagnosticSeverity.Warning;
        case 'note':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Error;
    }
}

function resolveCompilerPath(
    filePathText: string,
    currentBaseDir: string
): string {
    if (path.isAbsolute(filePathText)) {
        return path.normalize(filePathText);
    }
    return path.normalize(path.resolve(currentBaseDir, filePathText));
}

function publishDiagnosticsFromText(
    text: string,
    currentBaseDir: string,
    diagnostics: vscode.DiagnosticCollection
): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const lines = text.split(/\r?\n/);

    // file:line:column: error|warning|note: message
    const withColumn = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/;

    // file:line: error|warning|note: message
    const withoutColumn = /^(.*?):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/;

    for (const line of lines) {
        let match = withColumn.exec(line);
        let filePathText: string | undefined;
        let lineNumber = 1;
        let columnNumber = 1;
        let severityText = 'error';
        let message = '';

        if (match) {
            filePathText = match[1];
            lineNumber = Number.parseInt(match[2], 10);
            columnNumber = Number.parseInt(match[3], 10);
            severityText = match[4];
            message = match[5];
        } else {
            match = withoutColumn.exec(line);
            if (!match) {
                continue;
            }
            filePathText = match[1];
            lineNumber = Number.parseInt(match[2], 10);
            columnNumber = 1;
            severityText = match[3];
            message = match[4];
        }

        if (!filePathText) {
            continue;
        }

        const absolutePath = resolveCompilerPath(filePathText, currentBaseDir);
        const uri = vscode.Uri.file(absolutePath);

        const startLine = Math.max(0, lineNumber - 1);
        const startColumn = Math.max(0, columnNumber - 1);

        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(startLine, startColumn, startLine, startColumn + 1),
            message,
            severityFromText(severityText)
        );

        diagnostic.source = 'avr-gcc';

        const existing = byFile.get(uri.fsPath) ?? [];
        existing.push(diagnostic);
        byFile.set(uri.fsPath, existing);
    }

    for (const [file, items] of byFile.entries()) {
        diagnostics.set(vscode.Uri.file(file), items);
    }
}

async function detectSerialPorts(): Promise<string[]> {
    const results = new Set<string>();

    if (process.platform === 'linux') {
        const devDir = '/dev';
        try {
            for (const name of fs.readdirSync(devDir)) {
                if (
                    name.startsWith('ttyUSB') ||
                    name.startsWith('ttyACM') ||
                    name.startsWith('ttyAMA') ||
                    name.startsWith('ttyS')
                ) {
                    results.add(path.join(devDir, name));
                }
            }
        } catch {
            // Ignore detection errors; user can still set manually.
        }
    } else if (process.platform === 'darwin') {
        const devDir = '/dev';
        try {
            for (const name of fs.readdirSync(devDir)) {
                if (name.startsWith('tty.') || name.startsWith('cu.')) {
                    results.add(path.join(devDir, name));
                }
            }
        } catch {
            // Ignore detection errors.
        }
    } else if (process.platform === 'win32') {
        for (let i = 1; i <= 32; i++) {
            results.add(`COM${i}`);
        }
    }

    return Array.from(results).sort((a, b) => a.localeCompare(b));
}

async function selectUploadPort(): Promise<void> {
    const config = vscode.workspace.getConfiguration('avr-asm-builder');
    const current = config.get<string>('avrdudePort', '/dev/ttyUSB0');
    const detected = await detectSerialPorts();

    const picks: vscode.QuickPickItem[] = [];
    const seen = new Set<string>();

    if (current) {
        picks.push({
            label: current,
            description: 'current setting'
        });
        seen.add(current);
    }

    for (const port of detected) {
        if (seen.has(port)) {
            continue;
        }
        picks.push({
            label: port,
            description: 'detected'
        });
        seen.add(port);
    }

    if (picks.length === 0) {
        vscode.window.showWarningMessage(
            'No serial ports detected automatically. Set avr-asm-builder.avrdudePort manually in Settings.'
        );
        return;
    }

    const choice = await vscode.window.showQuickPick(picks, {
        title: 'Select AVR Upload Port',
        placeHolder: 'Choose a serial port to store in settings'
    });

    if (!choice) {
        return;
    }

    const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    await config.update('avrdudePort', choice.label, target);
    vscode.window.showInformationMessage(`AVR upload port set to ${choice.label}`);
}

function updateButtonsVisibility(
    buildButton: vscode.StatusBarItem,
    uploadButton: vscode.StatusBarItem
): void {
    const editor = vscode.window.activeTextEditor;
    const visible = !!editor && path.extname(editor.document.fileName).toLowerCase() === '.s';

    if (visible) {
        buildButton.show();
        uploadButton.show();
    } else {
        buildButton.hide();
        uploadButton.hide();
    }
}

async function buildCurrentFile(
    output: vscode.OutputChannel,
    diagnostics: vscode.DiagnosticCollection
): Promise<boolean> {
    const doc = getActiveDocument();

    if (!doc) {
        vscode.window.showErrorMessage('No active editor.');
        return false;
    }

    const validationError = validateDocument(doc);
    if (validationError) {
        vscode.window.showErrorMessage(validationError);
        return false;
    }

    await doc.save();

    diagnostics.clear();

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

    const assembleResult = await runCommand(
        avrGcc,
        ['-mmcu=' + mcu, '-c', p.source, '-o', p.object],
        p.baseDir,
        output
    );

    publishDiagnosticsFromText(assembleResult.stderr, p.baseDir, diagnostics);

    if (assembleResult.code !== 0) {
        output.appendLine('\nFAILED at assemble');
        vscode.window.showErrorMessage('AVR build failed at assemble stage.');
        return false;
    }

    const linkArgs = useNoStartFiles
        ? ['-mmcu=' + mcu, '-nostartfiles', p.object, '-o', p.elf]
        : ['-mmcu=' + mcu, p.object, '-o', p.elf];

    const linkResult = await runCommand(
        avrGcc,
        linkArgs,
        p.baseDir,
        output
    );

    publishDiagnosticsFromText(linkResult.stderr, p.baseDir, diagnostics);

    if (linkResult.code !== 0) {
        output.appendLine('\nFAILED at link');
        vscode.window.showErrorMessage('AVR build failed at link stage.');
        return false;
    }

    const objcopyResult = await runCommand(
        avrObjcopy,
        ['-O', 'ihex', '-R', '.eeprom', p.elf, p.hex],
        p.baseDir,
        output
    );

    if (objcopyResult.code !== 0) {
        output.appendLine('\nFAILED at objcopy');
        vscode.window.showErrorMessage('AVR build failed at HEX conversion stage.');
        return false;
    }

    output.appendLine('\nSIZE:');
    const sizeResult = await runCommand(
        avrSize,
        [p.elf],
        p.baseDir,
        output
    );

    if (sizeResult.code !== 0) {
        output.appendLine('\nWarning: avr-size failed.');
    }

    output.appendLine('\nBUILD OK');
    vscode.window.showInformationMessage('Build OK');
    return true;
}

async function uploadCurrentHex(output: vscode.OutputChannel): Promise<void> {
    const doc = getActiveDocument();

    if (!doc) {
        vscode.window.showErrorMessage('No active editor.');
        return;
    }

    const validationError = validateDocument(doc);
    if (validationError) {
        vscode.window.showErrorMessage(validationError);
        return;
    }

    const config = vscode.workspace.getConfiguration('avr-asm-builder');
    const avrdude = config.get<string>('avrdudePath', 'avrdude');
    const programmer = config.get<string>('avrdudeProgrammer', 'arduino');
    const port = config.get<string>('avrdudePort', '/dev/ttyUSB0');
    const baud = config.get<number>('avrdudeBaud', 115200);
    const mcu = config.get<string>('mcu', 'atmega328p');

    const p = getPaths(doc);

    if (!fs.existsSync(p.hex)) {
        vscode.window.showErrorMessage(`HEX not found: ${p.hex}. Build first.`);
        return;
    }

    output.clear();
    output.show(true);

    output.appendLine(`HEX   : ${p.hex}`);
    output.appendLine(`MCU   : ${mcu}`);
    output.appendLine(`Port  : ${port}`);
    output.appendLine(`Prog  : ${programmer}`);
    output.appendLine(`Baud  : ${baud}`);
    output.appendLine('');

    const uploadResult = await runCommand(
        avrdude,
        [
            '-c', programmer,
            '-p', mcu,
            '-P', port,
            '-b', String(baud),
            '-D',
            '-U', `flash:w:${p.hex}:i`
        ],
        p.baseDir,
        output
    );

    if (uploadResult.code !== 0) {
        output.appendLine('\nUPLOAD FAILED');
        vscode.window.showErrorMessage('Upload failed.');
        return;
    }

    output.appendLine('\nUPLOAD OK');
    vscode.window.showInformationMessage('Upload OK');
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('AVR ASM Builder');
    const diagnostics = vscode.languages.createDiagnosticCollection('avr-asm-builder');

    const buildCommand = vscode.commands.registerCommand(
        'avr-asm-builder.buildCurrentFile',
        async () => {
            try {
                await buildCurrentFile(output, diagnostics);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                output.show(true);
                output.appendLine(`\nERROR: ${message}`);
                vscode.window.showErrorMessage(`Build failed: ${message}`);
            }
        }
    );

    const uploadCommand = vscode.commands.registerCommand(
        'avr-asm-builder.uploadCurrentHex',
        async () => {
            try {
                await uploadCurrentHex(output);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                output.show(true);
                output.appendLine(`\nERROR: ${message}`);
                vscode.window.showErrorMessage(`Upload failed: ${message}`);
            }
        }
    );

    const selectPortCommand = vscode.commands.registerCommand(
        'avr-asm-builder.selectUploadPort',
        async () => {
            try {
                await selectUploadPort();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Selecting upload port failed: ${message}`);
            }
        }
    );

    const buildButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    buildButton.text = '$(tools) AVR Build';
    buildButton.tooltip = 'Build current AVR .s file';
    buildButton.command = 'avr-asm-builder.buildCurrentFile';

    const uploadButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    uploadButton.text = '$(arrow-up) AVR Upload';
    uploadButton.tooltip = 'Upload current HEX';
    uploadButton.command = 'avr-asm-builder.uploadCurrentHex';

    setTimeout(() => {
        updateButtonsVisibility(buildButton, uploadButton);
    }, 100);

    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
        updateButtonsVisibility(buildButton, uploadButton);
    });

    const documentCloseDisposable = vscode.workspace.onDidCloseTextDocument((doc) => {
        diagnostics.delete(doc.uri);
    });

    context.subscriptions.push(
        output,
        diagnostics,
        buildCommand,
        uploadCommand,
        selectPortCommand,
        buildButton,
        uploadButton,
        editorChangeDisposable,
        documentCloseDisposable
    );
}

export function deactivate(): void {
    // No explicit cleanup needed right now.
}