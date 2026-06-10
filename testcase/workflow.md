# detaches_agent 测试 Workflow

## 本地开发自测

```bash
pnpm typecheck
pnpm build
pnpm --filter @detaches/openclaw-detaches-adapter test
pnpm smoke
node testcase/run-full-test.mjs
```

## Agent 分析测试结果流程

1. 执行：

   ```bash
   node testcase/run-full-test.mjs
   ```

2. 读取输出文件：

   ```text
   testcase/results/full-test-latest.json
   ```

3. agent 分析规则：

   - 先看 `summary.failed`。
   - 若失败，逐条检查 `tests[].stderr` 和 `tests[].stdout`。
   - 判断失败属于：
     - 编译错误
     - mock Gateway 协议错误
     - terminal 持久性错误
     - 环境/端口错误
   - 给出修复建议。

## CI 建议

后续可接入 GitHub Actions：

```yaml
steps:
  - run: pnpm install --frozen-lockfile
  - run: node testcase/run-full-test.mjs
  - uses: actions/upload-artifact
    with:
      name: full-test-result
      path: testcase/results/full-test-latest.json
```
