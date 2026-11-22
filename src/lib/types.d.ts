import {
  ChatInputCommandInteraction,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandOptionsOnlyBuilder,
  AutocompleteInteraction,
  ModalSubmitInteraction,
  CacheType,
  Collection,
} from "discord.js";
import { SeatRoleEngine } from "./classes/seat/RoleEngine";
import type { StateMachineHandler } from "./classes/recruit/StateMachineHandler";

export interface SlashCommand {
  command: SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  guildType: "nis" | "recruit";
  autocomplete?: (interaction: AutocompleteInteraction) => void;
  modal?: (interaction: ModalSubmitInteraction<CacheType>) => void;
  cooldown?: number;
}

declare module "discord.js" {
  export interface Client {
    commands: Collection<string, SlashCommand>;
    seatRoleEngine?: SeatRoleEngine;
    guildIdMap?: Record<string, string>;
    recruitStateMachine?: StateMachineHandler;
  }
}
