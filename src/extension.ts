import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    getSerialMonitorApi,
    Version,
    LineEnding,
    Parity,
    StopBits,
    SerialMonitorApi
} from '@microsoft/vscode-serial-monitor-api';

let lastAttemptedPort: string | undefined = undefined;

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

function getConfigurationTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}

function mapLineEnding(value: string): LineEnding {
    switch (value.toLowerCase()) {
        case 'lf':
            return LineEnding.LF;
        case 'crlf':
            return LineEnding.CRLF;
        default:
            return LineEnding.None;
    }
}

async function selectMonitorPort(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('avr-asm-builder');
    const current = config.get<string>('serial.port', '');
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
        const manual = await vscode.window.showInputBox({
            title: 'Serial Monitor Port',
            prompt: 'Enter serial monitor port manually',
            placeHolder: process.platform === 'win32' ? 'COM3' : '/dev/ttyUSB0',
            value: current
        });

        if (!manual) {
            return undefined;
        }

        await config.update('serial.port', manual, getConfigurationTarget());
        return manual;
    }

    const choice = await vscode.window.showQuickPick(picks, {
        title: 'Select Serial Monitor Port',
        placeHolder: 'Choose a serial port for Serial Monitor'
    });

    if (!choice) {
        return undefined;
    }

    await config.update('serial.port', choice.label, getConfigurationTarget());
    return choice.label;
}

async function openSerialMonitor(
    context: vscode.ExtensionContext
): Promise<void> {
    const config = vscode.workspace.getConfiguration('avr-asm-builder');
    let port = config.get<string>('serial.port', '').trim();
    const baudRate = config.get<number>('serial.baudRate', 115200);
    const lineEndingValue = config.get<string>('serial.lineEnding', 'none');

    if (!port) {
        const selected = await selectMonitorPort();
        if (!selected) return;
        port = selected;
    }

    const api = await getSerialMonitorApi(Version.latest, context);
    if (!api) return;

    // --- REUSE LOGIC ---
    if (lastAttemptedPort === port) {
        // Focus the existing group to bring the tab to front
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        
        try {
            // Very short race to trigger a focus/refresh without 
            // waiting for the driver error that spawns the second window.
            await Promise.race([
                api.startMonitoringPort({
                    port, baudRate, lineEnding: mapLineEnding(lineEndingValue),
                    dataBits: 8, stopBits: StopBits.One, parity: Parity.None
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('STAY_SILENT')), 150))
            ]);
        } catch (e: any) {
            if (e.message === 'STAY_SILENT') return;
        }
    }

    // --- OPEN/RECONNECT LOGIC ---
    try {
        await api.startMonitoringPort({
            port: port,
            baudRate: baudRate,
            lineEnding: mapLineEnding(lineEndingValue),
            dataBits: 8,
            stopBits: StopBits.One,
            parity: Parity.None
        });

        lastAttemptedPort = port;
    } catch (err: any) {
        const msg = err?.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
        
        if (msg.toLowerCase().includes("busy") || msg.toLowerCase().includes("access denied")) {
            lastAttemptedPort = port;
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        } else {
            vscode.window.showErrorMessage(`Serial Monitor: ${msg}`);
            lastAttemptedPort = undefined; 
        }
    }
}

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
    uploadButton: vscode.StatusBarItem,
    monitorButton: vscode.StatusBarItem
): void {
    const editor = vscode.window.activeTextEditor;
    const ext = editor ? path.extname(editor.document.fileName).toLowerCase() : '';
    const showBuild = ext === '.s';
    const showUpload = ext === '.s' || ext === '.hex';
    const showMonitor = ext === '.s' || ext === '.hex';

    if (showBuild) {
        buildButton.show();
    } else {
        buildButton.hide();
    }

    if (showUpload) {
        uploadButton.show();
    } else {
        uploadButton.hide();
    }

    if (showMonitor) {
        monitorButton.show();
    } else {
        monitorButton.hide();
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

class AvrSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'avrAsmBuilder.sidebar';

    private view?: vscode.WebviewView;

    constructor(
        private readonly context: vscode.ExtensionContext
    ) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);
        this.postState();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'build':
                    await vscode.commands.executeCommand('avr-asm-builder.buildCurrentFile');
                    this.postState();
                    break;

                case 'upload':
                    await vscode.commands.executeCommand('avr-asm-builder.uploadCurrentHex');
                    this.postState();
                    break;

                case 'monitor':
                    await vscode.commands.executeCommand('avr-asm-builder.openSerialMonitor');
                    this.postState();
                    break;

                case 'selectPort':
                    await vscode.commands.executeCommand('avr-asm-builder.selectUploadPort');
                    this.postState();
                    break;

                case 'openSettings':
                    await vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        '@ext:pczekalski-dev.avr-assembler'
                    );
                    break;
            }
        });
    }

    public refresh(): void {
        this.postState();
    }

    private postState(): void {
        if (!this.view) {
            return;
        }

        const config = vscode.workspace.getConfiguration('avr-asm-builder');
        const mcu = config.get<string>('mcu', 'atmega328p');
        const port = config.get<string>('avrdudePort', '/dev/ttyUSB0');
        const programmer = config.get<string>('avrdudeProgrammer', 'arduino');
        const baud = config.get<number>('avrdudeBaud', 115200);
        const outputDirectory = config.get<string>('outputDirectory', 'build');
        const monitorPort = config.get<string>('serial.port', '');
        const monitorBaud = config.get<number>('serial.baudRate', 9600);

        this.view.webview.postMessage({
            type: 'state',
            mcu,
            port,
            programmer,
            baud,
            outputDirectory,
            monitorPort,
            monitorBaud
        });
    }

    private getHtml(webview: vscode.Webview): string {
        const htmlPath = vscode.Uri.file(
            path.join(this.context.extensionPath, 'resources', 'sidebar.html')
        );
        try {
        return fs.readFileSync(htmlPath.fsPath, 'utf8');
      } catch (err) {
        return `<!DOCTYPE html><html><body>Error loading sidebar: ${err}</body></html>`;
      }
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('AVR ASM Builder');
    const diagnostics = vscode.languages.createDiagnosticCollection('avr-asm-builder');
    const sidebarProvider = new AvrSidebarProvider(context);
    let serialMonitorApiDisposable: vscode.Disposable | undefined;


    const buildCommand = vscode.commands.registerCommand(
        'avr-asm-builder.buildCurrentFile',
        async () => {
            try {
                await buildCurrentFile(output, diagnostics);
                sidebarProvider.refresh();
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

                const config = vscode.workspace.getConfiguration('avr-asm-builder');
                const autoOpenAfterUpload = config.get<boolean>('serial.autoOpenAfterUpload', false);

                if (autoOpenAfterUpload) {
                    await openSerialMonitor(context);
                }

                sidebarProvider.refresh();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                output.show(true);
                output.appendLine(`\nERROR: ${message}`);
                vscode.window.showErrorMessage(`Upload failed: ${message}`);
            }
        }
    );
    const openSerialMonitorCommand = vscode.commands.registerCommand(
        'avr-asm-builder.openSerialMonitor',
        async () => {
            try {
                await openSerialMonitor(context);
                sidebarProvider.refresh();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Serial Monitor failed: ${message}`);
            }
        }
    );
    const selectPortCommand = vscode.commands.registerCommand(
        'avr-asm-builder.selectUploadPort',
        async () => {
            try {
                await selectUploadPort();
                sidebarProvider.refresh();
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

    const monitorButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    monitorButton.text = '$(plug) AVR Monitor';
    monitorButton.tooltip = 'Open AVR Serial Monitor';
    monitorButton.command = 'avr-asm-builder.openSerialMonitor';

    setTimeout(() => {
        updateButtonsVisibility(buildButton, uploadButton, monitorButton);
    }, 100);

    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
        updateButtonsVisibility(buildButton, uploadButton, monitorButton);
    });

    const documentCloseDisposable = vscode.workspace.onDidCloseTextDocument((doc) => {
        diagnostics.delete(doc.uri);
    });

    const sidebarDisposable = vscode.window.registerWebviewViewProvider(
        AvrSidebarProvider.viewType,
        sidebarProvider
    );

    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('avr-asm-builder')) {
            sidebarProvider.refresh();
        }
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
        documentCloseDisposable,
        sidebarDisposable,
        configChangeDisposable,
        openSerialMonitorCommand,
        monitorButton
    );
}

export function deactivate(): void {
    // No explicit cleanup needed right now.
}