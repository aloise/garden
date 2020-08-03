/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import dedent = require("dedent")
import { LoggerType } from "../logger/logger"
import { PrepareParams } from "./base"
import { Command, CommandResult, CommandParams } from "./base"
import { sleep } from "../util/util"
import { startServer } from "../server/server"
import { IntegerParameter } from "../cli/params"

export const defaultDashboardPort = 9700

const dashboardArgs = {}

const dashboardOpts = {
  port: new IntegerParameter({
    help: `The port number for the Garden dashboard to listen on.`,
    defaultValue: defaultDashboardPort,
  }),
}

type Args = typeof dashboardArgs
type Opts = typeof dashboardOpts

export class DashboardCommand extends Command<Args, Opts> {
  name = "dashboard"
  alias = "serve"
  help = "Starts the Garden dashboard for the current project and environment."

  cliOnly = true

  description = dedent`
    Starts the Garden dashboard for the current project, and your selected environment+namespace. The dashboard can be used to monitor your Garden project, look at logs, provider-specific dashboard pages and more.

    The dashboard will receive and display updates from other Garden processes that you run with the same Garden project, environment and namespace.

    Note: You must currently run one dashboard per-environment and namespace.
  `

  arguments = dashboardArgs
  options = dashboardOpts

  getLoggerType(): LoggerType {
    return "basic"
  }

  async prepare({ footerLog, opts }: PrepareParams<Args, Opts>) {
    this.server = await startServer({ log: footerLog, port: opts.port })
    return { persistent: true }
  }

  async action({ garden }: CommandParams<Args, Opts>): Promise<CommandResult<{}>> {
    this.server!.setGarden(garden)

    // The server doesn't block, so we need to loop indefinitely here.
    while (true) {
      await sleep(10000)
    }
  }
}
