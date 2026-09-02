# 0002_provider_secrets rollback

先回滚应用到仍能识别 `secret_ref` 的兼容版本。密文不得自动解密回写 `api_key_encrypted`；如业务必须回退，需通过审批把 Secret/KMS 注入旧应用的运行时环境，而不是恢复数据库明文。

确认所有 Provider 已迁走且无引用后，可保留 `secret_envelopes` 和 `secret_ref` 作为兼容空列。生产回滚不自动 DROP 表或列，避免不可逆删除密钥材料。
