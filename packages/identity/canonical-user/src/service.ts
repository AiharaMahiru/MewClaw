import type {
  CanonicalMembersInput,
  CanonicalUserResolver,
  PrincipalId,
  PrincipalResolution,
  ResolveForUsageInput,
} from "./types.js";

/** Context 暴露的窄服务，不持有 Writer 或数据库 executor。 */
export class DefaultCanonicalUserService implements CanonicalUserResolver {
  readonly #resolver: CanonicalUserResolver;

  constructor(resolver: CanonicalUserResolver) {
    this.#resolver = resolver;
  }

  resolveForUsage(input: ResolveForUsageInput): Promise<PrincipalResolution> {
    return this.#resolver.resolveForUsage(input);
  }

  members(input: CanonicalMembersInput): Promise<readonly PrincipalId[]> {
    return this.#resolver.members(input);
  }
}
