import { Vercel } from "@vercel/sdk";
import type { EnvTarget } from "./env-spec.js";
import { CliError } from "./log.js";

/**
 * A thin, honest wrapper over `@vercel/sdk`.
 *
 * It exists for two reasons: to keep `teamId` threading out of every command,
 * and to turn the SDK's loose response unions into the couple of shapes this
 * tool actually needs. Everything it does maps 1:1 onto a documented REST
 * endpoint — nothing is reimplemented or guessed.
 */

export interface ProjectSummary {
  id: string;
  name: string;
  /**
   * The project's owner: a team id, or a personal account's own id. It is
   * what the Vercel CLI wants in VERCEL_ORG_ID (F-48). Null only if the API
   * left it out.
   */
  accountId: string | null;
  framework: string | null;
  /** Production alias(es), when Vercel reports them. */
  aliases: string[];
  /** The project's git connection, which may deploy production on its own (F-49). */
  git: ProjectGit;
}

/**
 * What decides whether Vercel deploys production by itself on a push (F-49):
 * a connected repository (`link`) promotes every push to its production
 * branch, unless an Ignored Build Step skips the build.
 */
export interface ProjectGit {
  /** The connected repository, e.g. `github:acme/kit`, or null when none is. */
  repository: string | null;
  /** The branch whose pushes Vercel builds and promotes to production. */
  productionBranch: string | null;
  /** The project's Ignored Build Step command, when one is set. */
  ignoreCommand: string | null;
}

/** The project's `link`, in the one shape {@link ProjectGit} needs, whichever provider it is. */
export function projectGit(link: unknown, ignoreCommand: unknown): ProjectGit {
  const ignore = typeof ignoreCommand === "string" && ignoreCommand.trim() ? ignoreCommand : null;
  if (!link || typeof link !== "object")
    return { repository: null, productionBranch: null, ignoreCommand: ignore };
  const l = link as {
    type?: string;
    org?: string;
    repo?: string;
    owner?: string;
    slug?: string;
    projectNameWithNamespace?: string;
    productionBranch?: string;
  };
  // github / github-limited / github-custom-host / vercel / v0 name org + repo;
  // gitlab its namespace; bitbucket owner + slug.
  const name =
    l.projectNameWithNamespace ??
    (l.owner && l.slug ? `${l.owner}/${l.slug}` : l.org && l.repo ? `${l.org}/${l.repo}` : (l.repo ?? l.org));
  return {
    repository: `${l.type ?? "git"}:${name ?? "a connected repository"}`,
    productionBranch: l.productionBranch || null,
    ignoreCommand: ignore,
  };
}

/**
 * The deployment a production host points at (F-51): what a failed release
 * rolls back to.
 */
export interface ServingDeployment {
  /** The deployment's id (`dpl_…`), which `vercel promote` takes. */
  id: string;
  /** Its own hostname (`<name>-<hash>.vercel.app`), for the operator, when the API names it. */
  url: string | null;
}

export interface EnvVarSummary {
  id: string;
  key: string;
  /** Always an array: the API answers a single target as a bare string. */
  target: string[];
  type: string;
  comment?: string;
  /** Confines the entry to one Preview branch: the target's other deployments do not read it. */
  gitBranch?: string;
  /** Confines the entry to custom environments. */
  customEnvironmentIds: string[];
  /**
   * The stored value, ONLY where Vercel hands it back in the clear: a `plain`
   * entry, or a public one read back through {@link VercelClient.readEnvValue}
   * (F-46). An `encrypted` entry lists ciphertext and a `sensitive` one lists
   * nothing, so neither keeps a value here.
   */
  value?: string;
}

export class VercelClient {
  private readonly sdk: Vercel;
  private readonly teamId: string | undefined;

  constructor(token: string, teamId?: string) {
    this.sdk = new Vercel({ bearerToken: token });
    this.teamId = teamId;
  }

  /** `teamId` is omitted entirely for a personal account — sending undefined is fine, sending "" is not. */
  private scope<T extends object>(input: T): T & { teamId?: string } {
    return this.teamId ? { ...input, teamId: this.teamId } : input;
  }

  async whoami(): Promise<{ authenticated: true; visibleProjects: number }> {
    try {
      const response = await this.sdk.projects.getProjects(this.scope({ limit: "1" }));
      return { authenticated: true, visibleProjects: normalizeProjects(response).length };
    } catch (err) {
      throw asCliError(err, "Could not authenticate against the Vercel API");
    }
  }

  async getProject(idOrName: string): Promise<ProjectSummary> {
    try {
      const project = (await this.sdk.projects.getProject(this.scope({ idOrName }))) as {
        id: string;
        name: string;
        accountId?: string;
        framework?: string | null;
        alias?: Array<{ domain?: string }> | undefined;
        targets?: { production?: { alias?: string[] } };
        link?: unknown;
        commandForIgnoringBuildStep?: string | null;
      };
      const aliases = [
        ...(project.alias ?? []).map((a) => a.domain).filter((d): d is string => typeof d === "string"),
        ...(project.targets?.production?.alias ?? []),
      ];
      return {
        id: project.id,
        name: project.name,
        accountId: project.accountId || null,
        framework: project.framework ?? null,
        aliases: [...new Set(aliases)],
        git: projectGit(project.link, project.commandForIgnoringBuildStep),
      };
    } catch (err) {
      throw asCliError(err, `Could not read project \`${idOrName}\``);
    }
  }

  async listProjects(limit = 20): Promise<Array<{ id: string; name: string }>> {
    try {
      return normalizeProjects(await this.sdk.projects.getProjects(this.scope({ limit: String(limit) })));
    } catch (err) {
      throw asCliError(err, "Could not list projects");
    }
  }

  async createProject(name: string, framework: "nextjs" = "nextjs"): Promise<ProjectSummary> {
    try {
      const created = (await this.sdk.projects.createProject(
        this.scope({ requestBody: { name, framework } }) as Parameters<
          Vercel["projects"]["createProject"]
        >[0],
      )) as { id: string; name: string; accountId?: string; framework?: string | null };
      return {
        id: created.id,
        name: created.name,
        accountId: created.accountId || null,
        framework: created.framework ?? null,
        aliases: [],
        git: projectGit(null, null),
      };
    } catch (err) {
      throw asCliError(err, `Could not create project \`${name}\``);
    }
  }

  /**
   * Every entry on the project, with the fields a presence check needs
   * (F-46): each entry's targets and its branch or custom-environment
   * scoping, which decide which deployments read it, and its type, which
   * decides whether its value can be verified. The value itself is kept only
   * for a `plain` entry, which the listing returns in the clear. Nothing is
   * decrypted here.
   */
  async listEnv(idOrName: string): Promise<EnvVarSummary[]> {
    try {
      const result = (await this.sdk.projects.filterProjectEnvs(this.scope({ idOrName }))) as {
        envs?: Array<{
          id?: string;
          key: string;
          target?: string[] | string;
          type: string;
          comment?: string;
          gitBranch?: string;
          customEnvironmentIds?: string[];
          value?: string;
        }>;
      } & { key?: string };
      // The endpoint returns `{ envs: [...] }` for a project-wide read.
      const envs = Array.isArray(result.envs) ? result.envs : [];
      return envs.map((env) => ({
        id: env.id ?? "",
        key: env.key,
        target: Array.isArray(env.target) ? env.target : typeof env.target === "string" ? [env.target] : [],
        type: env.type,
        comment: env.comment,
        ...(env.gitBranch ? { gitBranch: env.gitBranch } : {}),
        customEnvironmentIds: Array.isArray(env.customEnvironmentIds) ? env.customEnvironmentIds : [],
        ...(env.type === "plain" && typeof env.value === "string" ? { value: env.value } : {}),
      }));
    } catch (err) {
      throw asCliError(err, `Could not list environment variables for \`${idOrName}\``);
    }
  }

  /**
   * One entry's value, decrypted by the API (`GET /v1/projects/{id}/env/{envId}`),
   * or null when Vercel will not return it: a `sensitive` entry answers with
   * no value at all. Called only for PUBLIC values (see `readPublicValues`),
   * so no secret is ever fetched into this process.
   */
  async readEnvValue(idOrName: string, entry: { id: string; key: string }): Promise<string | null> {
    try {
      const env = (await this.sdk.projects.getProjectEnv(this.scope({ idOrName, id: entry.id }))) as {
        type?: string;
        value?: unknown;
        decrypted?: boolean;
      };
      if (env.type === "sensitive" || typeof env.value !== "string") return null;
      return env.type === "plain" || env.decrypted === true ? env.value : null;
    } catch (err) {
      throw asCliError(err, `Could not read ${entry.key} back to verify it`);
    }
  }

  /**
   * Creates or overwrites one variable. `upsert: "true"` makes this idempotent,
   * which is what lets `env:sync` be re-run safely — the alternative is a 403
   * "already exists" on the second run.
   */
  async upsertEnv(
    idOrName: string,
    variable: {
      key: string;
      value: string;
      type: "encrypted" | "plain" | "sensitive";
      target: EnvTarget[];
      comment?: string;
    },
  ): Promise<void> {
    try {
      await this.sdk.projects.createProjectEnv(
        this.scope({
          idOrName,
          upsert: "true",
          requestBody: {
            key: variable.key,
            value: variable.value,
            type: variable.type,
            target: variable.target,
            ...(variable.comment ? { comment: variable.comment.slice(0, 500) } : {}),
          },
        }) as Parameters<Vercel["projects"]["createProjectEnv"]>[0],
      );
    } catch (err) {
      throw asCliError(err, `Could not set ${variable.key}`);
    }
  }

  async removeEnv(idOrName: string, envId: string): Promise<void> {
    try {
      await this.sdk.projects.removeProjectEnv(this.scope({ idOrName, id: envId }));
    } catch (err) {
      throw asCliError(err, "Could not remove an environment variable");
    }
  }

  async latestProductionDeployment(projectId: string): Promise<{
    uid: string;
    url: string;
    state: string;
    createdAt: number | undefined;
  } | null> {
    try {
      const result = (await this.sdk.deployments.getDeployments(
        this.scope({ projectId, target: "production", limit: 1 }),
      )) as {
        deployments?: Array<{
          uid: string;
          url: string;
          state?: string;
          readyState?: string;
          created?: number;
        }>;
      };
      const deployment = result.deployments?.[0];
      if (!deployment) return null;
      return {
        uid: deployment.uid,
        url: deployment.url,
        state: deployment.state ?? deployment.readyState ?? "unknown",
        createdAt: deployment.created,
      };
    } catch (err) {
      throw asCliError(err, "Could not list deployments");
    }
  }

  /**
   * The deployment `host` is aliased to right now (`GET /v4/aliases/{host}`),
   * or null when the project has no such alias: a project never deployed to
   * production, or a host it does not serve (F-51).
   *
   * This, and not {@link latestProductionDeployment} or the project's
   * `targets.production`, is what production serves. The first is the LATEST
   * production deployment, and the second is not documented as more than that
   * (its deployments carry a `STAGED` substate). After an Instant Rollback, a
   * staged build or a rolling release the latest is not the one the domain
   * points at, and rolling back to it could restore a build someone had
   * already rolled back from. The alias is also exactly the host the
   * post-deploy probe requests.
   */
  async servingDeployment(host: string, projectId: string): Promise<ServingDeployment | null> {
    try {
      const alias = await this.sdk.aliases.getAlias(this.scope({ idOrAlias: host, projectId }));
      const id = alias.deploymentId ?? alias.deployment?.id;
      if (!id) return null;
      return { id, url: alias.deployment?.url ?? null };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw asCliError(err, `Could not read which deployment ${host} serves`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Marketplace storage (Postgres)                                   */
  /* ---------------------------------------------------------------- */

  /** Installed marketplace integrations, e.g. Neon. */
  async listIntegrationConfigurations(): Promise<Array<{ id: string; slug: string }>> {
    try {
      const result = (await this.sdk.integrations.getConfigurations(
        this.scope({ view: "account" }) as Parameters<Vercel["integrations"]["getConfigurations"]>[0],
      )) as unknown;
      const list = Array.isArray(result) ? result : [];
      return list
        .map((item) => item as { id?: string; slug?: string; integration?: { slug?: string } })
        .filter((item): item is { id: string; slug: string } => typeof item.id === "string")
        .map((item) => ({ id: item.id, slug: item.slug ?? "" }));
    } catch (err) {
      throw asCliError(err, "Could not list marketplace integrations");
    }
  }

  async listIntegrationProducts(
    configurationId: string,
  ): Promise<Array<{ id: string; slug: string; name: string }>> {
    try {
      const result = (await this.sdk.integrations.getConfigurationProducts(
        this.scope({ id: configurationId }) as Parameters<
          Vercel["integrations"]["getConfigurationProducts"]
        >[0],
      )) as unknown;
      const list = Array.isArray(result) ? result : ((result as { products?: unknown[] }).products ?? []);
      return (list as Array<{ id?: string; slug?: string; name?: string }>)
        .filter((p): p is { id: string; slug: string; name: string } => typeof p.id === "string")
        .map((p) => ({ id: p.id, slug: p.slug ?? "", name: p.name ?? p.slug ?? p.id }));
    } catch (err) {
      throw asCliError(err, "Could not list integration products");
    }
  }

  /**
   * Provisions a store on an installed integration. Omitting `billingPlanId`
   * makes Vercel auto-discover the free plan, which is what a first Postgres
   * should land on.
   */
  async createIntegrationStore(input: {
    name: string;
    integrationConfigurationId: string;
    integrationProductIdOrSlug: string;
    billingPlanId?: string;
  }): Promise<{ id: string; status: string }> {
    try {
      const result = (await this.sdk.integrations.createIntegrationStoreDirect(
        this.scope({
          requestBody: {
            name: input.name,
            integrationConfigurationId: input.integrationConfigurationId,
            integrationProductIdOrSlug: input.integrationProductIdOrSlug,
            source: "cli",
            ...(input.billingPlanId ? { billingPlanId: input.billingPlanId } : {}),
          },
        }) as Parameters<Vercel["integrations"]["createIntegrationStoreDirect"]>[0],
      )) as { store?: { externalResourceId?: string; id?: string; status?: string } };
      const store = result.store ?? {};
      return { id: store.id ?? store.externalResourceId ?? "(unknown)", status: store.status ?? "unknown" };
    } catch (err) {
      throw asCliError(err, "Could not provision the database");
    }
  }

  /** Connects a provisioned store to the project, injecting its env vars. */
  async connectStoreToProject(input: {
    integrationConfigurationId: string;
    resourceId: string;
    projectId: string;
  }): Promise<void> {
    try {
      await this.sdk.integrations.connectIntegrationResourceToProject(
        this.scope({
          integrationConfigurationId: input.integrationConfigurationId,
          resourceId: input.resourceId,
          requestBody: { projectId: input.projectId },
        }) as Parameters<Vercel["integrations"]["connectIntegrationResourceToProject"]>[0],
      );
    } catch (err) {
      throw asCliError(err, "Could not connect the database to the project");
    }
  }
}

/**
 * `GET /v9/projects` answers with either a bare array or an object carrying
 * `projects`, depending on the query. Both shapes are in the SDK's response
 * union, so normalize once rather than guessing at each call site.
 */
function normalizeProjects(response: unknown): Array<{ id: string; name: string }> {
  const list = Array.isArray(response)
    ? response
    : ((response as { projects?: unknown[] } | null)?.projects ?? []);
  return (list as Array<{ id?: unknown; name?: unknown }>)
    .filter((p): p is { id: string; name: string } => typeof p.id === "string" && typeof p.name === "string")
    .map((p) => ({ id: p.id, name: p.name }));
}

/** Turns an SDK error into a CliError with the API's own message preserved. */
function asCliError(err: unknown, context: string): CliError {
  const error = err as {
    statusCode?: number;
    message?: string;
    body?: unknown;
    data$?: { error?: { message?: string } };
  };
  const status = error.statusCode;
  const apiMessage = error.data$?.error?.message ?? error.message ?? String(err);

  if (status === 401 || status === 403) {
    return new CliError(`${context}: ${apiMessage}`, {
      hint: "The token may be expired, scoped to another team, or missing the required scope. Re-run `drk-deploy login`, or pass --team.",
    });
  }
  if (status === 404) {
    return new CliError(`${context}: not found (404).`, {
      hint: "Check the project id/name and whether it belongs to a team (pass --team <team_id>).",
    });
  }
  return new CliError(`${context}: ${apiMessage}`);
}
