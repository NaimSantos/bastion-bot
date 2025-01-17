import { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v9";
import { CommandInteraction } from "discord.js";
import { Logger } from "./logger";
import { Metrics } from "./metrics";
import { serializeCommand } from "./utils";

export abstract class Command {
	static get meta(): RESTPostAPIApplicationCommandsJSONBody {
		throw new Error("Not implemented");
	}

	// Hack: https://github.com/Microsoft/TypeScript/issues/3841#issuecomment-337560146
	["constructor"]: typeof Command;
	constructor(private metrics: Metrics) {}

	get meta(): RESTPostAPIApplicationCommandsJSONBody {
		return this.constructor.meta;
	}

	protected abstract get logger(): Logger;

	/**
	 * Execute this command in response to a Slash Command. May throw exceptions,
	 * which will be captured and logged appropriately, and feedback will be
	 * provided to the user.
	 *
	 * @param interaction
	 * @returns latency metric in milliseconds
	 */
	protected abstract execute(interaction: CommandInteraction): Promise<number>;

	/**
	 * Run this command in response to user interaction from start to finish.
	 * Does not throw exceptions.
	 *
	 * @param interaction
	 */
	async run(interaction: CommandInteraction): Promise<void> {
		try {
			this.logger.verbose(serializeCommand(interaction, { event: "attempt", ping: interaction.client.ws.ping }));
			const latency = await this.execute(interaction);
			this.logger.verbose(serializeCommand(interaction, { event: "success", latency }));
			this.metrics.writeCommand(interaction, latency);
		} catch (error) {
			this.metrics.writeCommand(interaction, -1);
			this.logger.error(serializeCommand(interaction), error);
			await interaction
				.followUp("Something went wrong")
				.catch(e => this.logger.error(serializeCommand(interaction), e));
		}
	}
}
