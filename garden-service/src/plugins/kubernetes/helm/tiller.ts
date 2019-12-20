/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { LogEntry } from "../../../logger/log-entry"
import { KubernetesResource } from "../types"
import { helm } from "./helm-cli"
import { safeLoadAll, safeDump } from "js-yaml"
import { KubeApi, getKubeConfig } from "../api"
import { checkResourceStatuses } from "../status/status"
import { combineStates } from "../../../types/service"
import { KubernetesPluginContext } from "../config"
import { convertDeprecatedManifestVersion } from "../util"
import Bluebird from "bluebird"
import tmp from "tmp-promise"
import { findByName, getNames } from "../../../util/util"
import { ConfigurationError } from "../../../exceptions"
import { writeFile } from "fs-extra"
import { resolve } from "path"

// DEPRECATED: remove all this in v0.12.0

const serviceAccountName = "garden-tiller"

export async function checkTillerStatus(ctx: KubernetesPluginContext, api: KubeApi, namespace: string, log: LogEntry) {
  const manifests = await getTillerManifests(ctx, log, namespace)
  const statuses = await checkResourceStatuses(api, namespace, manifests, log)

  return combineStates(statuses.map((s) => s.state))
}

export async function migrateToHelm3(ctx: KubernetesPluginContext, api: KubeApi, namespace: string, log: LogEntry) {
  const migrationLog = log.info(`-> Migrating from Helm 2.x (Tiller) to Helm 3 in namespace ${namespace}`)
  let res
  // List all releases in Helm 2 (Tiller)
  try {
    res = await helm({
      ctx,
      namespace,
      log,
      args: ["list", "--output", "json"],
      version: 2,
    })
  } catch (error) {
    log.silly("No tiller deployments found. Will continue and try to remove other existing Helm resources.")
  }

  // If helm is deployed we continue with the removal process
  // If no releases are found we skip this and we remove the remaining resources before returning.
  if (res) {
    // ... of course it returns an empty string when there are no releases
    const listFromTiller = res.trim() === "" ? { Releases: [] } : JSON.parse(res)
    const tillerReleaseNames = listFromTiller.Releases.filter((r: any) => r.Status === "DEPLOYED").map(
      (r: any) => r.Name
    )

    // List all releases in Helm 3
    const listFromHelm3 = JSON.parse(
      await helm({
        ctx,
        namespace,
        log,
        args: ["list", "--output", "json"],
      })
    )
    const helm3ReleaseNames = listFromHelm3.map((r: any) => r.name)

    // Install the 2to3 plugin
    try {
      await helm({
        ctx,
        namespace,
        log,
        args: ["plugin", "install", "https://github.com/helm/helm-2to3"],
      })
    } catch (err) {
      // Ugh ffs...
      if (err.message.includes("plugin already exists")) {
        await helm({
          ctx,
          namespace,
          log,
          args: ["plugin", "update", "2to3"],
        })
      } else {
        throw err
      }
    }

    // Convert each release from Tiller that isn't already in Helm 3
    for (const releaseName of tillerReleaseNames) {
      if (helm3ReleaseNames.includes(releaseName)) {
        continue
      }

      migrationLog.info(`-> Migrating release ${namespace}/${releaseName} from Tiller to Helm 3`)

      // The 2to3 plugin doesn't support multiple files in KUBECONFIG, and does not support/respect the
      // --kube-context parameter at all. I'm sure for really good reasons because this is not important
      // at all. (Yeah I'm pissed off because this has wasted a lot of my time, sorrynotsorry.)
      // So (breathe deep) we need to extract a temporary kube config file for the occasion.
      const tmpDir = await tmp.dir({ unsafeCleanup: true })

      try {
        const config = await getKubeConfig(log, ctx.provider)

        const contextName = ctx.provider.config.context
        const context = findByName(config.contexts, contextName)

        if (!context) {
          const contextNames = getNames(config.contexts)
          throw new ConfigurationError(`Could not find context ${contextName}`, { contextName, contextNames })
        }

        const clusterName = context.context.cluster
        const cluster = findByName(config.clusters, clusterName)

        if (!cluster) {
          const clusterNames = getNames(config.clusters)
          throw new ConfigurationError(`Could not find cluster ${clusterName} referenced in context ${contextName}`, {
            clusterName,
            contextName,
            clusterNames,
          })
        }

        const userName = context.context.user
        const user = findByName(config.users, userName)

        if (!user) {
          const userNames = getNames(config.users)
          throw new ConfigurationError(`Could not find user ${userName} referenced in context ${contextName}`, {
            userName,
            contextName,
            clusterNames: userNames,
          })
        }

        const resolvedConfig = {
          "apiVersion": "v1",
          "kind": "Config",
          "preferences": config.preferences || {},
          "current-context": context.name,
          "contexts": [context],
          "clusters": [cluster],
          "users": [user],
        }

        const configPath = resolve(tmpDir.path, "kubeconfig.json")
        await writeFile(configPath, safeDump(resolvedConfig))

        log.debug(
          await helm({
            ctx,
            namespace,
            log,
            args: ["2to3", "convert", releaseName, "--tiller-ns", namespace],
            env: {
              KUBECONFIG: configPath,
            },
          })
        )
      } finally {
        await tmpDir.cleanup()
      }
    }
  }

  // Remove Tiller resources
  log.info(`-> Removing Tiller from namespace ${namespace}`)
  await removeTiller(ctx, api, namespace, log)

  log.info(`-> Helm 3 migration complete!`)
}

async function removeTiller(ctx: KubernetesPluginContext, api: KubeApi, namespace: string, log: LogEntry) {
  const manifests = await getTillerManifests(ctx, log, namespace)

  return Bluebird.map(manifests, (resource) => api.deleteBySpec(namespace, resource, log))
}

async function getTillerManifests(
  ctx: KubernetesPluginContext,
  log: LogEntry,
  namespace: string
): Promise<KubernetesResource[]> {
  const tillerManifests = await helm({
    ctx,
    log,
    args: ["init", "--service-account", serviceAccountName, "--dry-run", "--debug"],
    version: 2,
  })

  const resources = safeLoadAll(tillerManifests).map(convertDeprecatedManifestVersion)

  return [...getRoleManifests(namespace), ...resources]
}

function getRoleManifests(namespace: string) {
  return [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: serviceAccountName,
        namespace,
      },
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: {
        name: serviceAccountName,
        namespace,
      },
      rules: [
        {
          apiGroups: ["*"],
          resources: ["*"],
          verbs: ["*"],
        },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: {
        name: serviceAccountName,
        namespace,
      },
      roleRef: {
        kind: "Role",
        name: serviceAccountName,
        apiGroup: "rbac.authorization.k8s.io",
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: serviceAccountName,
          namespace,
        },
      ],
    },
    // TODO: either get rid of Tiller entirely, or find a more narrow (yet usable) way to limit permissions
    // cluster-wide. The reason for this is that often Helm charts contain cluster-scoped objects that are in practice
    // difficult to limit the creation of, especically for dev.
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: {
        name: serviceAccountName + "-cluster-admin",
      },
      roleRef: {
        kind: "ClusterRole",
        name: "cluster-admin",
        apiGroup: "rbac.authorization.k8s.io",
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: serviceAccountName,
          namespace,
        },
      ],
    },
  ]
}
