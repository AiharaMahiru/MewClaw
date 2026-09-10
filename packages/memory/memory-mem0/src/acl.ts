/** 所有 SQL 都必须带完整 Scope 和 Cube ACL 谓词；先取后滤禁止。 */
export const ACCESSIBLE_CUBE = `
  c.tenant_id = $1::text AND c.bot_id = $2::text AND c.deployment_id = $3::text AND (
    (c.visibility = 'user_private' AND c.owner_user_id = $4::text)
    OR (c.visibility IN ('project_shared', 'agent_shared') AND EXISTS (
      SELECT 1 FROM memory_cube_members cm
      WHERE cm.cube_id = c.id AND cm.user_id = $4::text
    ))
    OR c.visibility = 'deployment_shared'
    OR (c.visibility = 'tenant_shared' AND c.tenant_id = $1::text)
  )
`;

export const EDITABLE_CUBE = `
  c.tenant_id = $1::text AND c.bot_id = $2::text AND c.deployment_id = $3::text AND (
    c.owner_user_id = $4::text
    OR EXISTS (
      SELECT 1 FROM memory_cube_members cm
      WHERE cm.cube_id = c.id AND cm.user_id = $4::text AND cm.role IN ('owner', 'editor')
    )
  )
`;
