export type ControlCapabilityState = "disabled" | "available" | "approval-required";

export interface ControlStatus {
  state: ControlCapabilityState;
  message: string;
}
