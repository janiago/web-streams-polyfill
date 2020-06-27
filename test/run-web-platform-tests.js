// This runs the web platform tests against the reference implementation, in Node.js using jsdom, for easier rapid
// development of the reference implementation and the web platform tests.
/* eslint-disable no-console */

const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const micromatch = require('micromatch');
const wptRunner = require('wpt-runner');
const consoleReporter = require('wpt-runner/lib/console-reporter.js');
const { FilteringReporter } = require('./wpt-util/filtering-reporter.js');

const readFileAsync = promisify(fs.readFile);

// wpt-runner does not yet support unhandled rejection tracking a la
// https://github.com/w3c/testharness.js/commit/7716e2581a86dfd9405a9c00547a7504f0c7fe94
// So we emulate it with Node.js events
const rejections = new Map();
process.on('unhandledRejection', (reason, promise) => {
  rejections.set(promise, reason);
});

process.on('rejectionHandled', promise => {
  rejections.delete(promise);
});

main().catch(e => {
  console.error(e.stack);
  process.exitCode = 1;
});

async function main() {
  const supportsES2018 = runtimeSupportsAsyncGenerators();

  const excludedTests = [
    // We cannot polyfill TransferArrayBuffer yet, so disable tests for detached array buffers
    // See https://github.com/MattiasBuelens/web-streams-polyfill/issues/3
    'readable-byte-streams/bad-buffers-and-views.any.html'
  ];
  const ignoredFailures = {};

  const ignoredFailuresMinified = {
    'idlharness.any.html': [
      // Terser turns `(a = undefined) => {}` into `(a) => {}`, changing the function's length property
      // Therefore we cannot correctly implement methods with optional arguments
      /interface: operation (abort|cancel|enqueue|error|getReader|write)/,
      // Same thing for ReadableStream.values(), which is tested as part of the async iterable declaration
      'ReadableStream interface: async iterable<any>'
    ]
  };

  if (!supportsES2018) {
    excludedTests.push(
      // Skip tests that use async generators or for-await-of
      'readable-streams/async-iterator.any.html',
      'readable-streams/patched-global.any.html'
    );
    ignoredFailures['readable-streams/general.any.html'] = [
      // Symbol.asyncIterator does not exist
      'ReadableStream instances should have the correct list of properties'
    ];
  }

  const ignoredFailuresES6 = merge(ignoredFailures, {
    'readable-streams/async-iterator.any.html': [
      // ES6 build will not use correct %AsyncIteratorPrototype%
      'Async iterator instances should have the correct list of properties'
    ]
  });

  const ignoredFailuresES5 = merge(ignoredFailuresES6, {
    'idlharness.any.html': [
      // ES5 build does not set correct length on constructors with optional arguments
      'ReadableStream interface object length',
      'WritableStream interface object length',
      'TransformStream interface object length',
      // ES5 build does not set correct length on methods with optional arguments
      /interface: operation \w+\(.*optional.*\)/,
      'ReadableStream interface: async iterable<any>',
      // ES5 build does not set correct function name on getters and setters
      /interface: attribute/,
      // ES5 build has { writable: true } on prototype objects
      /interface: existence and properties of interface prototype object/
    ]
  });

  let failures = 0;

  if (supportsES2018) {
    failures += await runTests('polyfill.es2018.js', { excludedTests, ignoredFailures });
    failures += await runTests('polyfill.es2018.min.js', {
      excludedTests,
      ignoredFailures: merge(ignoredFailures, ignoredFailuresMinified)
    });
  }

  failures += await runTests('polyfill.es6.js', {
    excludedTests,
    ignoredFailures: ignoredFailuresES6
  });
  failures += await runTests('polyfill.es6.min.js', {
    excludedTests,
    ignoredFailures: merge(ignoredFailuresES6, ignoredFailuresMinified)
  });

  failures += await runTests('polyfill.js', {
    excludedTests,
    ignoredFailures: ignoredFailuresES5
  });
  failures += await runTests('polyfill.min.js', {
    excludedTests,
    ignoredFailures: merge(ignoredFailuresES5, ignoredFailuresMinified)
  });

  process.exitCode = failures;
}

async function runTests(entryFile, { excludedTests = [], ignoredFailures = {} } = {}) {
  const entryPath = path.resolve(__dirname, `../dist/${entryFile}`);
  const wptPath = path.resolve(__dirname, 'web-platform-tests');
  const testsPath = path.resolve(wptPath, 'streams');

  const includedTests = process.argv.length >= 3 ? process.argv.slice(2) : ['**/*.html'];
  const includeMatcher = micromatch.matcher(includedTests);
  const excludeMatcher = micromatch.matcher(excludedTests);
  const workerTestPattern = /\.(?:dedicated|shared|service)worker(?:\.https)?\.html$/;

  const reporter = new FilteringReporter(consoleReporter, ignoredFailures);

  const bundledJS = await readFileAsync(entryPath, { encoding: 'utf8' });

  console.log(`>>> ${entryFile}`);

  const wptFailures = await wptRunner(testsPath, {
    rootURL: 'streams/',
    reporter,
    setup(window) {
      window.queueMicrotask = queueMicrotask;
      window.fetch = async function (url) {
        const filePath = path.join(wptPath, url);
        if (!filePath.startsWith(wptPath)) {
          throw new TypeError('Invalid URL');
        }
        return {
          ok: true,
          async text() {
            return await readFileAsync(filePath, { encoding: 'utf8' });
          }
        };
      };
      window.eval(bundledJS);
    },
    filter(testPath) {
      // Ignore the worker versions
      if (workerTestPattern.test(testPath)) {
        return false;
      }

      return includeMatcher(testPath) &&
          !excludeMatcher(testPath);
    }
  });
  const results = reporter.getResults();

  console.log();
  console.log(`${results.passed} tests passed, ${results.failed} failed, ${results.ignored} ignored`);

  let failures = Math.max(results.failed, wptFailures - results.ignored);

  if (rejections.size > 0) {
    if (failures === 0) {
      failures = 1;
    }

    for (const reason of rejections.values()) {
      console.error('Unhandled promise rejection: ', reason.stack);
    }
  }

  console.log();

  return failures;
}

function runtimeSupportsAsyncGenerators() {
  try {
    // eslint-disable-next-line no-new-func
    Function('(async function* f() {})')();
    return true;
  } catch (e) {
    return false;
  }
}

function merge(left, right) {
  const result = { ...left };
  for (const key of Object.keys(right)) {
    result[key] = [...(result[key] || []), ...right[key]];
  }
  return result;
}
