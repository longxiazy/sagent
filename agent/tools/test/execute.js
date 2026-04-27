/**
 * test_runner — 运行测试并用结果指导 Agent 决策
 *
 * 灵感来源: 测试驱动编程 (Test-Driven Development with LLMs)
 * Agent 在修改代码后运行测试，根据测试结果决定下一步
 *
 * 使用场景:
 * { tool: 'test', type: 'run', command: 'npm test', path: '/project' }
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../../helpers/logger.js';

const execAsync = promisify(exec);

export async function executeTestAction(action) {
  const { type, command, path = '.', timeout = 60000 } = action;

  if (type === 'run' || type === 'run_tests') {
    if (!command) throw new Error('test.run 缺少 command');

    log.info(`[TestRunner] Running: ${command} in ${path}`);

    let stdout = '', stderr = '';
    try {
      const { stdout: out, stderr: err } = await execAsync(command, {
        cwd: path,
        timeout,
        maxBuffer: 1024 * 1024 * 10, // 10MB
        killSignal: 'SIGKILL',
      });
      stdout = out;
      stderr = err;
    } catch (err) {
      // Test failure is not necessarily an error - parse the output
      stdout = err.stdout || '';
      stderr = err.stderr || '';
      const exitCode = err.code || 1;

      // Parse test results from output
      const parsed = parseTestOutput(stdout + '\n' + stderr);

      if (parsed) {
        const lines = [
          `[TestRunner] 测试结果 (exit ${exitCode}):`,
          `  通过: ${parsed.passed || 0}`,
          `  失败: ${parsed.failed || 0}`,
          `  跳过: ${parsed.skipped || 0}`,
          `  总计: ${parsed.total || 0}`,
        ];
        if (parsed.failed > 0) {
          lines.push(`\n❌ ${parsed.failed} 个测试失败:`);
          (parsed.failures || []).forEach((f, i) => {
            lines.push(`  ${i + 1}. ${f}`);
          });
          return lines.join('\n');
        } else {
          lines.push('\n✅ 所有测试通过！');
          return lines.join('\n');
        }
      }

      return `[TestRunner] 测试完成 (exit ${exitCode}):\n${(stdout + '\n' + stderr).slice(0, 3000)}`;
    }

    // All tests passed
    const parsed = parseTestOutput(stdout + '\n' + stderr);
    if (parsed && parsed.failed === 0) {
      return `[TestRunner] ✅ 所有测试通过 (${parsed.passed}/${parsed.total})`;
    }

    return `[TestRunner] 测试输出:\n${stdout.slice(0, 5000)}`;
  }

  if (type === 'detect') {
    // Auto-detect test framework in project
    const commands = [];
    if (command) commands.push(command);

    const frameworks = [
      { pattern: 'package.json', hint: 'npm test / yarn test / pnpm test', cmd: 'npm test -- --version 2>/dev/null && echo "npm test available"' },
      { pattern: 'pytest.ini', hint: 'pytest', cmd: 'python3 -m pytest --version 2>/dev/null && echo "pytest available"' },
      { pattern: 'go.mod', hint: 'go test', cmd: 'go test -v ./... 2>&1 | head -5' },
      { pattern: 'Cargo.toml', hint: 'cargo test', cmd: 'cargo test --no-run 2>&1 | head -5' },
      { pattern: 'Makefile', hint: 'make test', cmd: 'grep -q "test" Makefile && echo "make test found"' },
    ];

    const results = [];
    for (const fw of frameworks) {
      results.push(`- ${fw.hint}`);
    }

    return `[TestRunner] 支持的测试框架:\n${results.join('\n')}\n\n请使用 test.run 指定具体命令`;
  }

  throw new Error(`不支持的 test 类型: ${type}`);
}

function parseTestOutput(output) {
  // Try Jest format: "Tests: 2 failed, 5 passed, 7 total"
  const jestMatch = output.match(/Tests?:\s*(?:(\d+)\s*failed[, ]*)?(?:(\d+)\s*passed[, ]*)?(?:(\d+)\s*total)?/i);
  if (jestMatch) {
    return {
      failed: parseInt(jestMatch[1] || '0'),
      passed: parseInt(jestMatch[2] || '0'),
      total: parseInt(jestMatch[3] || jestMatch[1] || '0'),
    };
  }

  // Try Vitest format: "✓ 5 tests passed"
  const vitestMatch = output.match(/(?:✓|pass|passed)[:\s]+(\d+)(\s+tests?)?/i);
  if (vitestMatch) {
    return { passed: parseInt(vitestMatch[1]), total: parseInt(vitestMatch[1]), failed: 0 };
  }

  // Try Pytest format: "3 passed, 1 error in 2.50s"
  const pytestMatch = output.match(/(\d+)\s+passed/i);
  if (pytestMatch) {
    const failedMatch = output.match(/(\d+)\s+failed/i);
    return {
      passed: parseInt(pytestMatch[1]),
      failed: parseInt(failedMatch?.[1] || '0'),
      total: parseInt(pytestMatch[1]) + parseInt(failedMatch?.[1] || '0'),
    };
  }

  return null;
}
