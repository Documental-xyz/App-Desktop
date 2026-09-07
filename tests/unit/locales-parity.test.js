/**
 * @fileoverview Locale key-parity guardian for src/locales/{en,pt-BR,es}.yaml
 *
 * Task 12 (publish-update-resilience): every key must exist in ALL three
 * locales with a non-empty value — a key present in only one locale falls
 * back to raw text or English inline in the renderer. This test fails with
 * a per-locale diff of missing/extra keys whenever the key-sets drift.
 *
 * Uses createRequire() to bypass vitest's global fs mocks (tests/setup.js),
 * same pattern as i18n-store.test.js.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const LOCALES_DIR = path.resolve(__dirname, '../../src/locales');
const LOCALES = ['en', 'pt-BR', 'es'];

function loadLocale(name) {
    const file = path.join(LOCALES_DIR, `${name}.yaml`);
    return yaml.load(fs.readFileSync(file, 'utf8'));
}

function flattenKeys(obj, prefix = '') {
    const keys = [];
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            keys.push(...flattenKeys(v, key));
        } else {
            keys.push(key);
        }
    }
    return keys;
}

function loadKeySets() {
    const sets = {};
    const values = {};
    for (const name of LOCALES) {
        const tree = loadLocale(name);
        sets[name] = new Set(flattenKeys(tree));
        values[name] = tree;
    }
    return { sets, values };
}

function diffLabel(locale, diff) {
    return diff.length === 0 ? '  (none)' : diff.map((k) => `  - ${k}`).join('\n');
}

function lookup(tree, dottedKey) {
    return dottedKey.split('.').reduce((acc, part) => (acc ? acc[part] : undefined), tree);
}

describe('locale key parity (en / pt-BR / es)', () => {
    const { sets, values } = loadKeySets();

    it('has an identical key-set in en and pt-BR', () => {
        const missingInPt = [...sets.en].filter((k) => !sets['pt-BR'].has(k));
        const extraInPt = [...sets['pt-BR']].filter((k) => !sets.en.has(k));
        expect(
            missingInPt.length === 0 && extraInPt.length === 0,
            `key-set mismatch en ↔ pt-BR\nmissing in pt-BR:\n${diffLabel('pt-BR', missingInPt)}\nextra in pt-BR:\n${diffLabel('pt-BR', extraInPt)}`
        ).toBe(true);
    });

    it('has an identical key-set in en and es', () => {
        const missingInEs = [...sets.en].filter((k) => !sets.es.has(k));
        const extraInEs = [...sets.es].filter((k) => !sets.en.has(k));
        expect(
            missingInEs.length === 0 && extraInEs.length === 0,
            `key-set mismatch en ↔ es\nmissing in es:\n${diffLabel('es', missingInEs)}\nextra in es:\n${diffLabel('es', extraInEs)}`
        ).toBe(true);
    });

    it('has non-empty values for key Task-12 strings in all locales (structural render check)', () => {
        const spotChecks = [
            'main.git_exec_stage_fetching',
            'main.git_exec_stage_restoring',
            'main.git_exec_error_large_file_title',
            'main.git_exec_restore_ok',
            'main.git_exec_logs_title',
        ];
        for (const key of spotChecks) {
            for (const name of LOCALES) {
                const value = lookup(values[name], key);
                expect(
                    typeof value === 'string' && value.trim().length > 0,
                    `${name}.yaml: expected non-empty string for "${key}", got ${JSON.stringify(value)}`
                ).toBe(true);
            }
        }
    });
});
