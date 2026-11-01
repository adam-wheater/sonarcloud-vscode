'use strict';

const path = require('path');
const fs = require('fs');
const Mocha = require('mocha');

/** Entry point VS Code calls inside the extension host. */
function run() {
    const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 30000 });
    const suiteDir = __dirname;
    for (const file of fs.readdirSync(suiteDir).filter(name => name.endsWith('.test.js'))) {
        mocha.addFile(path.join(suiteDir, file));
    }

    return new Promise((resolve, reject) => {
        try {
            mocha.run(failures => {
                if (failures > 0) {
                    reject(new Error(`${failures} integration test(s) failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { run };
