import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CodeMarkovChain } from './markov';

let models: Map<string, CodeMarkovChain> = new Map();
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let saveTimeout: NodeJS.Timeout | null = null;
let enabled: boolean = true;

export function activate(context: vscode.ExtensionContext) {
    console.log('Markov Code extension is now active!');

    outputChannel = vscode.window.createOutputChannel('Markov Code');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('Markov Code extension activated.');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'markov-code.train';
    context.subscriptions.push(statusBarItem);

    const storageDir = context.globalStorageUri.fsPath;
    if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
    } else {
        fs.readdirSync(storageDir).forEach(file => {
            if (file.startsWith('model-') && file.endsWith('.json')) {
                const lang = file.substring(6, file.length - 5);
                try {
                    const savedModel = fs.readFileSync(path.join(storageDir, file), 'utf-8');
                    const chain = new CodeMarkovChain();
                    if (chain.importModel(savedModel)) {
                        models.set(lang, chain);
                        outputChannel.appendLine(`Loaded saved model for ${lang}`);
                    }
                } catch (e) { /* Ignore */ }
            }
        });
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateStatusBar)
    );

    const provider: vscode.InlineCompletionItemProvider = {
        provideInlineCompletionItems(document, position, context, token) {
            if (!enabled) return;

            const lang = document.languageId;
            const chain = models.get(lang);
            if (!chain) return;

            const textBeforeCursor = document.getText(
                new vscode.Range(new vscode.Position(0, 0), position)
            );

            const blankLineMatch = textBeforeCursor.match(/\n\s*$/);
            const multipleBlankLines = textBeforeCursor.match(/\n\s*\n\s*$/);
            
            if (!textBeforeCursor.trim() || multipleBlankLines) return;
            
            const contextText = blankLineMatch ? textBeforeCursor + ' ' : textBeforeCursor;

            const maxTokens = vscode.workspace
                .getConfiguration('markov-code')
                .get<number>('maxSuggestionTokens', 15);

            const suggestion = chain.suggest(contextText, maxTokens);
            
            if (suggestion && suggestion.trim().length > 0) {
                return [new vscode.InlineCompletionItem(suggestion)];
            }
        }
    };

    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)
    );

    let trainDisposable = vscode.commands.registerCommand('markov-code.train', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showErrorMessage('Please open a file of the language you want to train on.');
            return;
        }

        const lang = activeEditor.document.languageId;
        const langToExt: { [key: string]: string } = {
            'python': '.py', 'javascript': '.js', 'typescript': '.ts',
            'java': '.java', 'cpp': '.cpp', 'c': '.c', 'go': '.go',
            'csharp': '.cs', 'ruby': '.rb'
        };

        const ext = langToExt[lang];
        if (!ext) {
            vscode.window.showErrorMessage(`Unsupported language: ${lang}.`);
            return;
        }

        const excludePattern = vscode.workspace
            .getConfiguration('markov-code')
            .get<string>('excludeFolders', '{**/node_modules/**,**/venv/**}');

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Training Markov Model for ${lang} (${ext})...`,
            cancellable: false
        }, async (progress) => {
            statusBarItem.text = `$(sync~spin) Markov: Training ${lang}...`;
            
            const stateSize = vscode.workspace.getConfiguration('markov-code').get<number>('stateSize', 2);
            const chain = new CodeMarkovChain(stateSize);
            let fileCount = 0;

            const files = await vscode.workspace.findFiles(`**/*${ext}`, excludePattern);
            
            for (let i = 0; i < files.length; i++) {
                progress.report({ 
                    message: `Processing file ${i + 1}/${files.length}`, 
                    increment: (100 / files.length) 
                });
                try {
                    const content = await fs.promises.readFile(files[i].fsPath, 'utf-8');
                    chain.train(content);
                    fileCount++;
                } catch (e) { /* Ignore */ }
            }

            if (fileCount === 0) {
                vscode.window.showWarningMessage(`No ${ext} files found to train on.`);
                updateStatusBar();
                return;
            }

            models.set(lang, chain);
            
            try {
                chain.pruneModel();
                const storagePath = path.join(storageDir, `model-${lang}.json`);
                fs.writeFileSync(storagePath, chain.exportModel(), 'utf-8');
                vscode.window.showInformationMessage(`Markov model trained on ${fileCount} ${lang} files and saved!`);
                outputChannel.appendLine(`Trained model for ${lang} on ${fileCount} files.`);
            } catch (err) {
                vscode.window.showErrorMessage(`Trained, but failed to save model: ${err}`);
            }
            
            updateStatusBar();
        });
    });

    let clearDisposable = vscode.commands.registerCommand('markov-code.clear', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) return;
        const lang = activeEditor.document.languageId;

        if (models.has(lang)) {
            models.delete(lang);
            const storagePath = path.join(storageDir, `model-${lang}.json`);
            if (fs.existsSync(storagePath)) {
                fs.unlinkSync(storagePath);
            }
            vscode.window.showInformationMessage(`Cleared Markov Code model for ${lang}.`);
        } else {
            vscode.window.showInformationMessage(`No model found for ${lang}.`);
        }
        updateStatusBar();
    });

    let statsDisposable = vscode.commands.registerCommand('markov-code.stats', () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) return;
        const lang = activeEditor.document.languageId;
        const chain = models.get(lang);
        if (!chain) return;

        const modelSize = chain.exportModel().length;
        const sizeInMB = (modelSize / (1024 * 1024)).toFixed(2);
        vscode.window.showInformationMessage(`Markov Stats [${lang}]: Model is ${sizeInMB} MB in memory.`);
    });

    let toggleDisposable = vscode.commands.registerCommand('markov-code.toggle', () => {
        enabled = !enabled;
        vscode.window.showInformationMessage(`Markov Code suggestions ${enabled ? 'enabled' : 'disabled'}.`);
        updateStatusBar();
    });

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            const config = vscode.workspace.getConfiguration('markov-code');
            const autoTrainEnabled = config.get<boolean>('autoTrain', true);
            if (!autoTrainEnabled) return;

            const lang = document.languageId;
            if (models.has(lang)) {
                const chain = models.get(lang)!;
                const content = document.getText();
                
                outputChannel.appendLine(`[Auto-Train] Updating ${lang} model in memory...`);
                chain.train(content);

                if (saveTimeout) clearTimeout(saveTimeout);
                
                saveTimeout = setTimeout(() => {
                    try {
                        chain.pruneModel();
                        const storagePath = path.join(storageDir, `model-${lang}.json`);
                        fs.writeFileSync(storagePath, chain.exportModel(), 'utf-8');
                        outputChannel.appendLine(`[Auto-Train] Model for ${lang} saved to disk.`);
                        saveTimeout = null;
                    } catch (err) {
                        outputChannel.appendLine(`[Auto-Train] Failed to save updated model: ${err}`);
                    }
                }, 3000);
            }
        })
    );

    context.subscriptions.push(trainDisposable);
    context.subscriptions.push(clearDisposable);
    context.subscriptions.push(statsDisposable);
    context.subscriptions.push(toggleDisposable);
    
    updateStatusBar();
}

function updateStatusBar() {
    if (!enabled) {
        statusBarItem.text = '$(circle-slash) Markov: Disabled';
        statusBarItem.tooltip = 'Markov Code is disabled. Click to enable.';
        statusBarItem.command = 'markov-code.toggle';
        return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        statusBarItem.text = '$(hubot) Markov: No File';
        statusBarItem.command = 'markov-code.toggle';
        return;
    }
    
    const lang = activeEditor.document.languageId;
    if (models.has(lang)) {
        statusBarItem.text = `$(check) Markov: ${lang} Ready`;
        statusBarItem.tooltip = `Model active for ${lang}. Click to retrain.`;
        statusBarItem.command = 'markov-code.train';
    } else {
        statusBarItem.text = `$(x) Markov: ${lang} Untrained`;
        statusBarItem.tooltip = `No model for ${lang}. Click to train.`;
        statusBarItem.command = 'markov-code.train';
    }
}

export function deactivate() {}
