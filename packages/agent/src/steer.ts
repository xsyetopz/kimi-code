/**
 * Hosts should drain steer messages after a tool batch and append them as
 * user messages before continuing the loop. Follow-ups are drained after a
 * turn completes and used as the next prompts.
 */
export class SteeringQueue {
  readonly #steer: string[] = [];
  readonly #followUp: string[] = [];

  pushSteer(text: string): void {
    if (text.length > 0) this.#steer.push(text);
  }

  pushFollowUp(text: string): void {
    if (text.length > 0) this.#followUp.push(text);
  }

  drainSteer(): string[] {
    return this.#steer.splice(0);
  }

  drainFollowUp(): string[] {
    return this.#followUp.splice(0);
  }
}
