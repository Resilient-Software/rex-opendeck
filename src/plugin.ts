import streamDeck from "@elgato/streamdeck";

import {
	CommandAction,
	CycleAction,
	KeysAction,
	NewSpaceAction,
	NewTabAction,
	SpaceAction,
	SummaryAction,
	TextAction,
} from "./actions";
import { DeckController } from "./controller";
import { Bridge } from "./rex";

const log = {
	error: (message: string) => streamDeck.logger.error(message),
	info: (message: string) => streamDeck.logger.info(message),
};
const controller = new DeckController({ bridge: new Bridge({ log: log.info }), log });
for (const Action of [SpaceAction, NewSpaceAction, SummaryAction, CommandAction, TextAction, KeysAction, CycleAction, NewTabAction]) {
	streamDeck.actions.registerAction(new Action(controller));
}

// Without a handler a signal skips the exit hook that stops the rex events child.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => process.exit(0));
}

await streamDeck.connect();
