import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'js-yaml';
import * as yargs from 'yargs';

import { Logger } from '@claw/types';
import ConsoleLogger from '@claw/util/logger';
import { CmdArgs } from '@claw/commands';
import { EventEmitter } from 'events';

type Registration = {
    id: string;
    token: string;
};

class AppConfig {
    id: string;
    token: string;
    url: string;
    home: string;
    logfile: string;
    pidfile: string;
    registrations: Registration[];
    tags: string[];
}

class App extends EventEmitter {
    argv: CmdArgs;
    config: AppConfig;
    logger: Logger = new ConsoleLogger();
    env: string; // TODO this concept does not fit well here
    DEBUG: number = 0;

    build({ argv, logger }: { argv: CmdArgs; logger?: Logger }) {
        this.argv = argv;
        this.DEBUG =
            argv.verbose === false
                ? 0
                : argv.verbose === true
                    ? 1
                    : argv.verbose;

        if (logger) {
            this.logger = logger;
        }

        this.config = this.configure(argv);
    }

    path(dirOrFile) {
        return path.join(this.config.home, dirOrFile);
    }

    info = this.logger.info.bind(this.logger);
    warn = this.logger.warn.bind(this.logger);
    error = this.logger.error.bind(this.logger);
    echo = this.logger.echo.bind(this.logger);
    milestone = this.logger.milestone.bind(this.logger);
    log = this.logger.info.bind(this.logger);

    debug(msg, ...args) {
        if (!this.DEBUG) return;
        this.logger.debug(msg, ...args);
    }

    fail(msg = 'system failure (no reason)', ...args) {
        this.logger.fatal(1, msg, ...args);
    }

    configure(argv) {
        let [configData] = this.loadConfigFile(argv.config);

        const config = {
            ...this.config,
            ...configData
        };

        Object.keys(argv).map(key => (config[key] = argv[key]));

        if (typeof config.tags === 'string') {
            config.tags = config.tags.split(',');
        } else if (!Array.isArray(config.tags)) {
            config.tags = [];
        }

        const { registrations } = config;

        if (Array.isArray(registrations) && registrations.length > 0) {
            if (config.id && !config.token) {
                registrations.forEach(registration => {
                    if (registration.id === config.id) {
                        config.token = registration.token;
                    }
                });
            } else if (!config.id && registrations.length === 1) {
                config.id = registrations[0].id;
                config.token = registrations[0].token;
            }
        }

        return config;
    }

    configCandidates(argvConfig): string[] {
        const CLA_WORKER_HOME = process.env.CLA_WORKER_HOME || process.cwd();
        return [
            argvConfig,
            process.env.CLA_WORKER_CONFIG,
            path.join(CLA_WORKER_HOME, './cla-worker.yml'),
            path.join(process.env.HOME, './cla-worker.yml'),
            path.join('/etc/cla-worker.yml')
        ];
    }

    loadConfigFile(argvConfig): any[] {
        if (argvConfig === false) {
            return [{}];
        }

        const configCandidates: string[] = this.configCandidates(argvConfig);

        for (const configPath of configCandidates.filter(it => it != null)) {
            this.debug(`checking for config file at ${configPath}...`);

            if (!fs.existsSync(configPath)) {
                if (configPath === argvConfig) {
                    throw `invalid config file '${configPath}'`;
                } else {
                    continue;
                }
            }

            this.debug(`found ${configPath}, loading...`);

            try {
                const baseFile = fs.readFileSync(configPath, 'utf8');
                return [YAML.safeLoad(baseFile), configPath];
            } catch (err) {
                throw `failed to load config file ${configPath}: ${err}`;
            }
        }
    }

    saveConfigFile(data) {
        const [currentConfig, configPath] = this.loadConfigFile(
            this.argv.config
        );

        const registrations = data.registrations;
        delete data.registrations;

        const newConfig = { ...currentConfig, ...data };

        if (registrations) {
            const regMap = {};

            newConfig.registrations.forEach(reg => (regMap[reg.id] = reg));
            registrations.forEach(reg => (regMap[reg.id] = reg));
            newConfig.registrations = Object.values(regMap);
        }

        const dump = YAML.safeDump(newConfig, { indent: 4, condenseFlow: true });

        this.debug(`saving config to file '${configPath}'...`);

        try {
            fs.writeFileSync(configPath, dump, 'utf8');
        } catch (err) {
            throw `failed to save config file '${configPath}': ${err}`;
        }

        return [configPath, dump ];
    }

    exitHandler = async signal => {
        this.echo('\n');
        this.warn(`cla-worker exiting on request signal=${signal}`);
        for (const listener of this.listeners('exit')) {
            await listener();
        }
        process.exit(2);
    };

    async startup() {
        //do something when app is closing
        process.on('SIGTERM', this.exitHandler);
        // process.on('exit', this.exitHandler);

        //catches ctrl+c event
        process.on('SIGINT', this.exitHandler);

        // catches "kill pid"
        process.on('SIGUSR1', this.exitHandler);
        process.on('SIGUSR2', this.exitHandler);

        //catches uncaught exceptions
        process.on('uncaughtException', this.exitHandler);

        return;
    }

    registry() {
        // TODO load registry here, from multiple special registry files (js or yaml?)
        //  located in server/registry/* and from plugins
    }

    loadPlugins() {
        /// TODO load all plugin code
    }

    daemonize() {
        const { logfile, pidfile } = this.config;

        fs.writeFileSync(pidfile, `${process.pid}\n`);
        var access = fs.createWriteStream(logfile);
        process.stdout.write = process.stderr.write = access.write.bind(access);
    }

    checkRunningDaemon() {
        const { pidfile, logfile } = this.config;

        this.info(`logfile=${logfile}`);
        this.info(`pidfile=${pidfile}`);

        try {
            const pid = fs.readFileSync(pidfile);
            process.kill(parseInt(pid.toString(), 10), 0);
            this.fail(
                `cannot start daemon: pidfile ${pidfile} currently exists and daemon is active with pid=${pid}`
            );
        } catch (err) {
            if (err.code !== 'ESRCH') {
                this.error(`error checking pidfile: ${err} (code=${err.code})`);
            }
        }
    }
}

export default new App();
