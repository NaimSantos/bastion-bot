import { Static } from "@sinclair/typebox";
import { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v9";
import { CommandInteraction, MessageEmbed } from "discord.js";
import { ApplicationCommandOptionTypes } from "discord.js/typings/enums";
import fetch from "node-fetch";
import { inject, injectable } from "tsyringe";
import { c, msgid, ngettext, t, useLocale } from "ttag";
import { parseURL, TypedDeck } from "ydke";
import { Command } from "../Command";
import { CardSchema } from "../definitions/yaml-yugi";
import { Locale, LocaleProvider } from "../locale";
import { getLogger, Logger } from "../logger";
import { Metrics } from "../metrics";
import { addNotice, replyLatency } from "../utils";

// Same hack as in card.ts
const rc = c;

@injectable()
export class DeckCommand extends Command {
	#logger = getLogger("command:deck");

	constructor(@inject(Metrics) metrics: Metrics, @inject("LocaleProvider") private locales: LocaleProvider) {
		super(metrics);
	}

	static override get meta(): RESTPostAPIApplicationCommandsJSONBody {
		return {
			name: "deck",
			description: "Display a deck list from ydke:// format, exported from a number of deck building programs.",
			options: [
				{
					type: ApplicationCommandOptionTypes.STRING.valueOf(),
					name: "deck",
					description: "The ydke:// URL of the deck you want to view.",
					required: true
				},
				{
					type: ApplicationCommandOptionTypes.BOOLEAN.valueOf(),
					name: "public",
					description: "Whether to display the deck details publicly in chat. This is false by default.",
					required: false
				},
				{
					type: ApplicationCommandOptionTypes.BOOLEAN.valueOf(),
					name: "stacked",
					description:
						"Whether to display the deck sections as one stacked column. This is false (side-by-side) by default.",
					required: false
				}
			]
		};
	}

	protected override get logger(): Logger {
		return this.#logger;
	}

	splitText(outString: string, cap = 1024): string[] {
		const outStrings: string[] = [];
		while (outString.length > cap) {
			let index = outString.slice(0, cap).lastIndexOf("\n");
			if (index === -1 || index >= cap) {
				index = outString.slice(0, cap).lastIndexOf(".");
				if (index === -1 || index >= cap) {
					index = outString.slice(0, cap).lastIndexOf(" ");
					if (index === -1 || index >= cap) {
						index = cap - 1;
					}
				}
			}
			outStrings.push(outString.slice(0, index + 1));
			outString = outString.slice(index + 1);
		}
		outStrings.push(outString);
		return outStrings;
	}

	async getCards(cards: Set<number>): Promise<Map<number, Static<typeof CardSchema>>> {
		const response = await fetch(`${process.env.SEARCH_API}/yaml-yugi/multi?password=${[...cards].join(",")}`);
		if (response.status === 200) {
			const body: (Static<typeof CardSchema> | null)[] = await response.json();
			const cardMemo = new Map<number, Static<typeof CardSchema>>();
			for (const card of body) {
				if (card?.password) {
					cardMemo.set(card.password, card);
				}
			}
			return cardMemo;
		}
		throw new Error((await response.json()).message);
	}

	async generateProfile(deck: TypedDeck, lang: Locale, inline: boolean): Promise<MessageEmbed> {
		// use Set to remove duplicates from list of passwords to pass to API
		// populate the names into a Map to be fetched linearly
		const cardMemo = await this.getCards(new Set([...deck.main, ...deck.extra, ...deck.side]));
		// apply the names to the record of the deck
		const getName = (password: number): string =>
			cardMemo.get(password)?.name[lang] || cardMemo.get(password)?.name.en || `${password}`;
		const namedDeck = {
			main: [...deck.main].map(getName),
			extra: [...deck.extra].map(getName),
			side: [...deck.side].map(getName)
		};
		// count the number of each card in the deck
		const count = (acc: Record<string, number>, val: string): Record<string, number> => {
			acc[val] = acc[val] ? acc[val] + 1 : 1;
			return acc;
		};
		const deckCounts = {
			main: namedDeck.main.reduce(count, {}),
			extra: namedDeck.extra.reduce(count, {}),
			side: namedDeck.side.reduce(count, {})
		};
		useLocale(lang);
		// count the number of each meaningful card type in the deck and construct embed
		function countMain(deck: Uint32Array): string {
			const counts = {
				Monster: 0,
				Spell: 0,
				Trap: 0
			};
			for (const password of deck) {
				const card = cardMemo.get(password);
				if (card) {
					counts[card.card_type]++;
				}
			}
			const display = [];
			if (counts.Monster) {
				display.push(ngettext(msgid`${counts.Monster} Monster`, `${counts.Monster} Monsters`, counts.Monster));
			}
			if (counts.Spell) {
				display.push(ngettext(msgid`${counts.Spell} Spell`, `${counts.Spell} Spells`, counts.Spell));
			}
			if (counts.Trap) {
				display.push(ngettext(msgid`${counts.Trap} Trap`, `${counts.Trap} Traps`, counts.Trap));
			}
			return display.join(", ");
		}
		function countExtraMonsterTypes(deck: Uint32Array): string {
			// Can be genericized for future use
			const types = ["Fusion", "Synchro", "Xyz", "Link"] as const;
			const counts = Object.fromEntries(types.map(type => [type, 0]));
			for (const password of deck) {
				const card = cardMemo.get(password);
				if (card?.card_type === "Monster") {
					const currentMonsterTypes = new Set(card.monster_type_line.split(" / "));
					for (const type of types) {
						if (currentMonsterTypes.has(type)) {
							counts[type]++;
							break; // assumption: mutually exclusive
						}
					}
				}
			}
			// Translations have already been configured in card.ts
			return Object.entries(counts)
				.filter(([, count]) => count > 0)
				.map(([type, count]) => `${count} ${rc("monster-type-race").gettext(type)}`)
				.join(", ");
		}
		const printCount = ([cardName, count]: [string, number]): string => `${count} ${cardName}`;
		const embed = new MessageEmbed();
		embed.setTitle(t`Your Deck`);
		if (deck.main.length > 0) {
			const content = Object.entries(deckCounts.main).map(printCount).join("\n");
			const [first, ...rest] = this.splitText(content);
			const countDetail = countMain(deck.main);
			const name = ngettext(
				msgid`Main Deck (${deck.main.length} card — ${countDetail})`,
				`Main Deck (${deck.main.length} cards — ${countDetail})`,
				deck.main.length
			);
			embed.addFields({ name, value: first, inline });
			for (const part of rest) {
				embed.addFields({ name: t`Main Deck (continued)`, value: part, inline });
			}
		}
		if (deck.extra.length > 0) {
			const content = Object.entries(deckCounts.extra).map(printCount).join("\n");
			const [first, ...rest] = this.splitText(content);
			const countDetail = countExtraMonsterTypes(deck.extra);
			const name = ngettext(
				msgid`Extra Deck (${deck.extra.length} card — ${countDetail})`,
				`Extra Deck (${deck.extra.length} cards — ${countDetail})`,
				deck.extra.length
			);
			embed.addFields({ name, value: first, inline });
			for (const part of rest) {
				embed.addFields({ name: t`Extra Deck (continued)`, value: part, inline });
			}
		}
		if (deck.side.length > 0) {
			const content = Object.entries(deckCounts.side).map(printCount).join("\n");
			const [first, ...rest] = this.splitText(content);
			const countDetail = countMain(deck.side);
			const name = ngettext(
				msgid`Side Deck (${deck.side.length} card — ${countDetail})`,
				`Side Deck (${deck.side.length} cards — ${countDetail})`,
				deck.side.length
			);
			embed.addFields({ name, value: first, inline });
			for (const part of rest) {
				embed.addFields({ name: t`Side Deck (continued)`, value: part, inline });
			}
		}
		return embed;
	}

	protected override async execute(interaction: CommandInteraction): Promise<number> {
		const resultLanguage = await this.locales.get(interaction);
		// NOTE: when we implement reading .ydk files, validate existence of headers/at least one populated section?
		let deck: TypedDeck;
		try {
			deck = parseURL(interaction.options.getString("deck", true));
		} catch (e) {
			// TODO: specifically catch error for bad input and respond more clearly?
			const reply = await interaction.reply({
				content: (e as Error).message,
				ephemeral: true,
				fetchReply: true
			});
			return replyLatency(reply, interaction);
		}
		// return error on empty deck
		if (deck.main.length + deck.extra.length + deck.side.length < 1) {
			useLocale(resultLanguage);
			const reply = await interaction.reply({
				content: t`Error: Your deck is empty.`,
				ephemeral: true,
				fetchReply: true
			});
			return replyLatency(reply, interaction);
		}
		const isPublic = !!interaction.options.getBoolean("public", false);
		const isStacked = !!interaction.options.getBoolean("stacked", false);
		await interaction.deferReply({ ephemeral: !isPublic });
		const content = await this.generateProfile(deck, resultLanguage, !isStacked);
		const end = Date.now();
		await interaction.editReply({ embeds: addNotice(content) });
		// When using deferReply, editedTimestamp is null, as if the reply was never edited, so provide a best estimate
		const latency = end - interaction.createdTimestamp;
		return latency;
	}
}
