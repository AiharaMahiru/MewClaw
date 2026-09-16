/**
 * 模型工具注册的 schema 守卫。
 *
 * 背景（R49 事故）：defineTool 会把字段表编译成 JSON Schema，但裸
 * ctx.tools.register 的 parameters 由 schemaOf 原样透传到 wire——
 * 传字段表会得到没有根 type 的 schema，provider 严格校验直接以
 * "type: null" 400 拒掉整轮请求。PTC 模式只发 run_code 掩盖了它，
 * native 模式 53 个工具全量上线才暴露。
 *
 * 所有不走 defineTool 的 .mjs 工具注册必须经 registerModelTool：
 * schema 不合法在插件装载期抛错（boot-check 烟测即拦截），而不是
 * 请求时才被 provider 拒绝。
 */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 断言 parameters 是 provider 可接受的 object 根 JSON Schema。
 * 只校验模型可见 wire 形状的硬约束；字段语义仍是作者的责任。
 */
export function assertModelToolSchema(name, parameters) {
  const label = `tool "${name}" parameters`
  if (!isRecord(parameters)) throw new TypeError(`${label} must be an object-root JSON Schema, got ${parameters === null ? 'null' : typeof parameters}`)
  if (parameters.type !== 'object') throw new TypeError(`${label} must declare type:"object" at the root (got ${JSON.stringify(parameters.type)}) — raw ctx.tools.register does not compile field tables`)
  if (parameters.properties !== undefined) {
    if (!isRecord(parameters.properties)) throw new TypeError(`${label}.properties must be a schema map`)
    for (const [key, value] of Object.entries(parameters.properties)) {
      if (!isRecord(value)) throw new TypeError(`${label}.properties.${key} must be a JSON Schema object`)
    }
  }
  if (parameters.required !== undefined) {
    if (!Array.isArray(parameters.required) || parameters.required.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new TypeError(`${label}.required must be an array of non-empty strings`)
    }
    if (isRecord(parameters.properties)) {
      for (const key of parameters.required) {
        if (!(key in parameters.properties)) throw new TypeError(`${label}.required lists "${key}" which is not declared in properties`)
      }
    }
  }
  if (parameters.additionalProperties !== undefined
    && typeof parameters.additionalProperties !== 'boolean'
    && !isRecord(parameters.additionalProperties)) {
    throw new TypeError(`${label}.additionalProperties must be a boolean or a JSON Schema object`)
  }
  // 循环引用、BigInt、函数等不可序列化值在 provider 边界才会炸，这里提前拦。
  try {
    JSON.stringify(parameters)
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${String(error)}`)
  }
}

/**
 * 校验后注册模型工具；等价于 ctx.tools.register，返回 disposer。
 * output.schema 只做可序列化检查（输出方向没有 object 根要求）。
 */
export function registerModelTool(ctx, definition) {
  if (!isRecord(definition)) throw new TypeError('registerModelTool: definition must be an object')
  assertModelToolSchema(definition.name ?? '<unnamed>', definition.parameters)
  if (definition.output !== undefined) {
    if (!isRecord(definition.output)) throw new TypeError(`tool "${definition.name}" output must be an object`)
    try {
      JSON.stringify(definition.output.schema ?? null)
    } catch (error) {
      throw new TypeError(`tool "${definition.name}" output.schema must be JSON-serializable: ${String(error)}`)
    }
  }
  return ctx.tools.register(definition)
}
