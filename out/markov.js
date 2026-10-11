"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeMarkovChain = void 0;
class CodeMarkovChain {
    stateSize;
    model;
    constructor(stateSize = 2) {
        this.stateSize = stateSize;
        this.model = new Map();
    }
    tokenize(text) {
        const regex = /\w+|[^\w\s]+|\s+/g;
        return text.match(regex) || [];
    }
    train(text) {
        const snippets = text.split(/\n\s*\n/);
        for (const snippet of snippets) {
            const trimmed = snippet.trim();
            if (trimmed.length < 10)
                continue;
            const tokens = this.tokenize(trimmed);
            const startTokens = new Array(this.stateSize).fill('<START>');
            const allTokens = [...startTokens, ...tokens, '<END>'];
            for (let i = 0; i < allTokens.length - this.stateSize; i++) {
                const state = allTokens.slice(i, i + this.stateSize).join('\u0000');
                const nextToken = allTokens[i + this.stateSize];
                if (!this.model.has(state)) {
                    this.model.set(state, new Map());
                }
                const transitions = this.model.get(state);
                transitions.set(nextToken, (transitions.get(nextToken) || 0) + 1);
            }
        }
    }
    pruneModel(maxTransitions = 30, minFrequency = 2) {
        for (const [state, transitions] of this.model) {
            if (transitions.size > maxTransitions) {
                const sorted = Array.from(transitions.entries()).sort((a, b) => b[1] - a[1]);
                const toKeep = new Map();
                for (const [token, count] of sorted) {
                    if (count < minFrequency && toKeep.size >= 5)
                        break;
                    toKeep.set(token, count);
                    if (toKeep.size >= maxTransitions)
                        break;
                }
                this.model.set(state, toKeep);
            }
        }
    }
    getWeightedChoice(transitions) {
        let total = 0;
        for (const count of transitions.values())
            total += count;
        let threshold = Math.random() * total;
        for (const [token, count] of transitions) {
            threshold -= count;
            if (threshold <= 0)
                return token;
        }
        return transitions.keys().next().value;
    }
    suggest(currentText, maxTokens = 15) {
        const contextWindow = currentText.slice(-1000);
        const tokens = this.tokenize(contextWindow);
        if (tokens.length === 0)
            return "";
        const lines = contextWindow.split('\n');
        const currentLine = lines[lines.length - 1];
        const baseIndentMatch = currentLine.match(/^[\s]*/);
        const baseIndent = baseIndentMatch ? baseIndentMatch[0] : '';
        let currentTokens = tokens.slice(-this.stateSize);
        if (currentTokens.length < this.stateSize) {
            const padding = new Array(this.stateSize - currentTokens.length).fill('<START>');
            currentTokens = [...padding, ...currentTokens];
        }
        const output = [];
        const openBrackets = [];
        const visitedStates = new Set();
        const lastTypedToken = tokens[tokens.length - 1];
        const isMidWord = /\w/.test(lastTypedToken.slice(-1));
        for (let i = 0; i < maxTokens; i++) {
            let transitions;
            let stateArr = [...currentTokens];
            while (stateArr.length > 0) {
                const stateKey = stateArr.join('\u0000');
                transitions = this.model.get(stateKey);
                if (transitions && transitions.size > 0)
                    break;
                stateArr.shift();
            }
            if (!transitions || transitions.size === 0)
                break;
            let nextToken = this.getWeightedChoice(transitions);
            if (!nextToken || nextToken === '<START>')
                continue;
            if (nextToken === '<END>')
                break;
            if (i === 0 && isMidWord) {
                const validCompletions = new Map();
                for (const [token, count] of transitions) {
                    if (token.startsWith(lastTypedToken)) {
                        validCompletions.set(token, count);
                    }
                }
                if (validCompletions.size === 0)
                    break;
                nextToken = this.getWeightedChoice(validCompletions);
                if (!nextToken)
                    break;
                output.push(nextToken.substring(lastTypedToken.length));
            }
            else {
                if (nextToken === '\n' && output.length > 0 && output[output.length - 1] === '\n')
                    break;
                output.push(nextToken);
            }
            currentTokens = [...currentTokens.slice(1), nextToken];
            const currentStateKey = currentTokens.join('\u0000');
            if (visitedStates.has(currentStateKey))
                break;
            visitedStates.add(currentStateKey);
            if (nextToken === '(' || nextToken === '[' || nextToken === '{') {
                openBrackets.push(nextToken);
            }
            else if (nextToken === ')' || nextToken === ']' || nextToken === '}') {
                if (openBrackets.length > 0)
                    openBrackets.pop();
            }
        }
        const bracketMap = { '(': ')', '[': ']', '{': '}' };
        while (openBrackets.length > 0) {
            output.push(bracketMap[openBrackets.pop()]);
        }
        let rawSuggestion = output.join('');
        if (rawSuggestion.includes('\n')) {
            const suggestionLines = rawSuggestion.split('\n');
            const indentedLines = suggestionLines.map((line, idx) => {
                if (idx === 0)
                    return line;
                return baseIndent + line;
            });
            return indentedLines.join('\n');
        }
        return rawSuggestion;
    }
    exportModel() {
        const modelArray = Array.from(this.model.entries()).map(([state, transitions]) => {
            return [state, Array.from(transitions.entries())];
        });
        return JSON.stringify({ stateSize: this.stateSize, model: modelArray });
    }
    importModel(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            this.stateSize = data.stateSize;
            this.model = new Map();
            for (const [state, transitionsArr] of data.model) {
                this.model.set(state, new Map(transitionsArr));
            }
            return true;
        }
        catch (e) {
            console.error("Failed to import model:", e);
            return false;
        }
    }
}
exports.CodeMarkovChain = CodeMarkovChain;
//# sourceMappingURL=markov.js.map