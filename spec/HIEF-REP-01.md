# HIEF-REP-01：Reputation 快照与更新语义规范 (v0.1)

- **状态**：Draft
- **版本**：0.1
- **依赖**：
    - HIEF-INT-01 v0.1
    - HIEF-SOL-01 v0.1
    - HIEF-POL-01 v0.1
- **目标**：定义 HIEF 网络中账户（用户/Agent/Solver）的信誉快照结构与更新语义，使信誉成为：
    - 可查询
    - 可复现
    - 可用于定价与风控
    - 可成为长期数据护城河

## 1. 设计目标

Reputation 设计必须满足：

1.  **可追溯（Temporal）**
    必须能说明“这个评分在什么时候成立”。
2.  **可验证（Verifiable）**
    链上数据可验证部分必须明确。
3.  **可分层（Layered）**
    区分链上可验证字段与链下推断字段。
4.  **可用于决策（Actionable）**
    必须能影响：
    - Solver 报价权重
    - Policy 风控强度
    - Skill 策略模板

## 2. ReputationSnapshot 顶层结构

ReputationSnapshot MUST 是 JSON 对象：

- `repVersion` (MUST)：固定 `"0.1"`
- `account` (MUST)：EVM 地址
- `asOf` (MUST)：快照时间点对象
- `scores` (MUST)：核心评分对象
- `metrics` (MUST)：原始指标对象
- `behaviorTags` (MUST)：行为标签数组
- `signature` (MAY)：由信誉服务签名

## 3. AsOf 对象

`asOf` MUST 包含：

- `chainId` (MUST)
- `blockNumber` (MUST)
- `timestamp` (MUST)

## 4. Scores 对象

`scores` MUST 包含：

- `successRate` (MUST)：0-10000 (万分位)
- `riskScore` (MUST)：0-1000 (越高越风险)
- `volumeScore` (MUST)：0-1000
- `diversityScore` (MUST)：0-1000
- `alphaScore` (MAY)：0-1000

## 5. Metrics 对象

`metrics` MUST 包含：

- `totalIntents` (MUST)
- `successfulIntents` (MUST)
- `failedIntents` (MUST)
- `totalVolumeUSD` (MUST)
- `uniqueSkillsUsed` (MUST)
- `lastActivityTimestamp` (MUST)

## 6. BehaviorTags

`behaviorTags` MUST 为字符串数组，示例：

- `"HIGH_FREQUENCY_TRADER"`
- `"ARBITRAGEUR"`
- `"LONG_TERM_HODLER"`
- `"YIELD_FARMER"`
- `"NFT_COLLECTOR"`

## 7. 更新语义

- **触发**：每次 Intent 终态（EXECUTED/FAILED/EXPIRED）后触发更新。
- **计算**：
    - `successRate` = `successfulIntents` / `totalIntents`
    - `riskScore` 基于 `failedIntents` 比例、高风险 `riskTags` 出现频率计算。
    - `volumeScore` 基于 `log(totalVolumeUSD)` 计算。
    - `diversityScore` 基于 `uniqueSkillsUsed` 计算。
- **时间衰减**：所有分数 SHOULD 包含时间衰减因子，近期行为权重更高。

## 8. 链上与链下

- **链上（ReputationNFT）**：SHOULD 只存储 `scores` 对象，作为轻量、可组合的“信誉证明”。
- **链下（API/DB）**：存储完整的 `ReputationSnapshot`，包含 `metrics` 和 `behaviorTags`。

## 9. 示例

```json
{
    "repVersion": "0.1",
    "account": "0x1111111111111111111111111111111111111111",
    "asOf": {
        "chainId": 8453,
        "blockNumber": 12345678,
        "timestamp": 1777777000
    },
    "scores": {
        "successRate": 9950,
        "riskScore": 150,
        "volumeScore": 850,
        "diversityScore": 600
    },
    "metrics": {
        "totalIntents": 100,
        "successfulIntents": 99,
        "failedIntents": 1,
        "totalVolumeUSD": "5000000",
        "uniqueSkillsUsed": 12,
        "lastActivityTimestamp": 1777776000
    },
    "behaviorTags": [
        "YIELD_FARMER",
        "HIGH_FREQUENCY_TRADER"
    ],
    "signature": {
        "type": "REPUTATION_SERVICE",
        "signer": "0xReputationService",
        "sig": "0x..."
    }
}
```
