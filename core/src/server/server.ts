/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Server } from "http"

import chalk from "chalk"
import Koa from "koa"
import mount = require("koa-mount")
import serve = require("koa-static")
import Router = require("koa-router")
import websockify from "koa-websocket"
import bodyParser = require("koa-bodyparser")
import getPort = require("get-port")
import { omit } from "lodash"

import { Garden } from "../garden"
import { prepareCommands, resolveRequest, CommandMap } from "./commands"
import { DASHBOARD_STATIC_DIR, gardenEnv } from "../constants"
import { LogEntry } from "../logger/log-entry"
import { CommandResult } from "../commands/base"
import { toGardenError, GardenError } from "../exceptions"
import { EventName, Events, EventBus, GardenEventListener } from "../events"
import { ValueOf } from "../util/util"
import { AnalyticsHandler } from "../analytics/analytics"
import { joi } from "../config/common"
import { randomString } from "../util/string"
import { authTokenHeader } from "../enterprise/auth"
import { ApiEventBatch } from "../enterprise/buffered-event-stream"

// Note: This is different from the `garden dashboard` default port.
// We may no longer embed servers in watch processes from 0.13 onwards.
export const defaultWatchServerPort = 9777
const notReadyMessage = "Waiting for Garden instance to initialize"

/**
 * Start an HTTP server that exposes commands and events for the given Garden instance.
 *
 * Please look at the tests for usage examples.
 *
 * NOTES:
 * If `port` is not specified, the default is used or a random free port is chosen if default is not available.
 * This is done so that a process can always create its own server, but we won't need that functionality once we
 * run a shared service across commands.
 */
export async function startServer({ log, port }: { log: LogEntry; port?: number }) {
  // Start HTTP API and dashboard server.
  // allow overriding automatic port picking
  if (!port) {
    port = gardenEnv.GARDEN_SERVER_PORT || undefined
  }
  const server = new GardenServer({ log, port })
  await server.start()
  return server
}

export class GardenServer {
  private log: LogEntry
  private server: Server
  private garden: Garden | undefined
  private app: websockify.App
  private analytics: AnalyticsHandler
  private incomingEvents: EventBus
  private statusLog: LogEntry
  private serversUpdatedListener: GardenEventListener<"serversUpdated">

  public port: number | undefined
  public readonly authKey: string

  constructor({ log, port }: { log: LogEntry; port?: number }) {
    this.log = log.placeholder()
    this.garden = undefined
    this.port = port
    this.authKey = randomString(64)
    this.incomingEvents = new EventBus()

    this.serversUpdatedListener = ({ servers }) => {
      // Update status log line with new `garden dashboard` server, if any
      for (const { host, command } of servers) {
        if (command === "dashboard") {
          this.showUrl(host)
          return
        }
      }

      // No active explicit dashboard processes, show own URL instead
      this.showUrl(this.getUrl())
    }
  }

  async start() {
    if (this.server) {
      return
    }

    this.app = await this.createApp()

    if (this.port) {
      this.server = this.app.listen(this.port)
    } else {
      do {
        try {
          this.port = await getPort({ port: defaultWatchServerPort })
          this.server = this.app.listen(this.port)
        } catch {}
      } while (!this.server)
    }

    this.log.info("")
    this.statusLog = this.log.placeholder()
  }

  getUrl() {
    return `http://localhost:${this.port}`
  }

  showUrl(url?: string) {
    this.statusLog.setState({
      emoji: "sunflower",
      msg: chalk.cyan("Garden dashboard running at ") + (url || this.getUrl()),
    })
  }

  async close() {
    return this.server.close()
  }

  setGarden(garden: Garden) {
    if (this.garden) {
      this.garden.events.removeListener("serversUpdated", this.serversUpdatedListener)
    }

    this.garden = garden

    // Serve artifacts as static assets
    this.app.use(mount("/artifacts", serve(garden.artifactsPath)))

    // Listen for new dashboard servers
    garden.events.on("serversUpdated", this.serversUpdatedListener)
  }

  private async createApp() {
    // prepare request-command map
    const commands = await prepareCommands()

    const app = websockify(new Koa())
    const http = new Router()

    /**
     * HTTP API endpoint (POST /api)
     *
     * We don't expose a different route per command, but rather accept a JSON object via POST on /api
     * with a `command` key. The API wouldn't be RESTful in any meaningful sense anyway, and this
     * means we can keep a consistent format across mechanisms.
     */
    http.post("/api", async (ctx) => {
      // TODO: require auth key here from 0.13.0 onwards
      if (!this.garden) {
        return this.notReady(ctx)
      }

      if (!this.analytics) {
        try {
          this.analytics = await AnalyticsHandler.init(this.garden, this.log)
        } catch (err) {
          throw err
        }
      }

      this.analytics.trackApi("POST", ctx.originalUrl, { ...ctx.request.body })

      const result = await resolveRequest(ctx, this.garden, this.log, commands, ctx.request.body)
      ctx.status = 200
      ctx.response.body = result
    })

    /**
     * Events endpoint, for ingesting events from other Garden processes, and piping to any open websocket connections.
     * Requires a valid auth token header, matching `this.authKey`.
     *
     * The API matches that of the Garden Enterprise /events endpoint.
     */
    http.post("/events", async (ctx) => {
      const authHeader = ctx.header[authTokenHeader]

      if (authHeader !== this.authKey) {
        ctx.status = 401
        return
      }

      // TODO: validate the input

      const batch = ctx.request.body as ApiEventBatch
      this.log.debug(`Received ${batch.events.length} events from session ${batch.sessionId}`)

      // Pipe the events to the incoming stream, which websocket listeners will then receive
      batch.events.forEach((e) => this.incomingEvents.emit(e.name, e.payload))

      ctx.status = 200
    })

    app.use(bodyParser())
    app.use(http.routes())
    app.use(http.allowedMethods())

    app.on("error", (err, ctx) => {
      this.log.info(`API server request failed with status ${ctx.status}: ${err.message}`)
    })

    // This enables navigating straight to a nested route, e.g. "localhost:<PORT>/graph".
    // FIXME: We need to be able to do this for any route, instead of hard coding the routes like this.
    const routes = ["/", "/graph", "/logs"]
    for (const route of routes) {
      app.use(mount(route, serve(DASHBOARD_STATIC_DIR)))
    }

    this.addWebsocketEndpoint(app, commands)

    return app
  }

  private notReady(ctx: Router.IRouterContext) {
    ctx.status = 503
    ctx.response.body = notReadyMessage
  }

  /**
   * Add the /ws endpoint to the Koa app. Every event emitted to the event bus is forwarded to open
   * Websocket connections, and clients can send commands over the socket and receive results on the
   * same connection.
   */
  private addWebsocketEndpoint(app: websockify.App, commands: CommandMap) {
    const wsRouter = new Router()

    wsRouter.get("/ws", async (ctx) => {
      if (!this.garden) {
        return this.notReady(ctx)
      }

      // TODO: require auth key on connections here, from 0.13.0 onwards

      // The typing for koa-websocket isn't working currently
      const websocket: Koa.Context["ws"] = ctx["websocket"]

      // Helper to make JSON messages, make them type-safe, and to log errors.
      const send = <T extends ServerWebsocketMessageType>(type: T, payload: ServerWebsocketMessages[T]) => {
        websocket.send(JSON.stringify({ type, ...(<object>payload) }), (err) => {
          if (err) {
            const error = toGardenError(err)
            this.log.error({ error })
          }
        })
      }

      // Pipe everything from the event bus to the socket, as well as from the /events endpoint
      const eventListener = (name: EventName, payload: any) => send("event", { name, payload })
      this.garden.events.onAny(eventListener)
      this.incomingEvents.onAny(eventListener)

      // Make sure we clean up listeners when connections end.
      // TODO: detect broken connections - https://github.com/websockets/ws#how-to-detect-and-close-broken-connections
      websocket.on("close", () => {
        this.garden && this.garden.events.offAny(eventListener)
        this.incomingEvents.offAny(eventListener)
      })

      // Respond to commands.
      websocket.on("message", (msg) => {
        let request: any

        try {
          request = JSON.parse(msg.toString())
        } catch {
          return send("error", { message: "Could not parse message as JSON" })
        }

        const requestId = request.id

        try {
          joi.attempt(
            requestId,
            joi
              .string()
              .uuid()
              .required()
          )
        } catch {
          return send("error", {
            message: "Message should contain an `id` field with a UUID value",
          })
        }

        try {
          joi.attempt(request.type, joi.string().required())
        } catch {
          return send("error", {
            message: "Message should contain a type field",
          })
        }

        if (request.type === "command") {
          if (!this.garden) {
            send("error", { requestId, message: notReadyMessage })
            return
          }

          resolveRequest(ctx, this.garden, this.log, commands, omit(request, ["id", "type"]))
            .then((result) => {
              send("commandResult", {
                requestId,
                result: result.result,
                errors: result.errors,
              })
            })
            .catch((err) => {
              send("error", { requestId, message: err.message })
            })
        } else {
          return send("error", {
            requestId,
            message: `Unsupported request type: ${request.type}`,
          })
        }
      })
    })

    app.ws.use(<Koa.Middleware<websockify.MiddlewareContext<any>>>wsRouter.routes())
    app.ws.use(<Koa.Middleware<websockify.MiddlewareContext<any>>>wsRouter.allowedMethods())
  }
}

interface ServerWebsocketMessages {
  commandResult: {
    requestId: string
    result: CommandResult<any>
    errors?: GardenError[]
  }
  error: {
    requestId?: string
    message: string
  }
  event: {
    name: EventName
    payload: ValueOf<Events>
  }
}

type ServerWebsocketMessageType = keyof ServerWebsocketMessages

export type ServerWebsocketMessage = ServerWebsocketMessages[ServerWebsocketMessageType] & {
  type: ServerWebsocketMessageType
}
