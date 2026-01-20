import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders drawing app title", () => {
  render(<App />);
  expect(screen.getByText(/simple drawing canvas/i)).toBeInTheDocument();
});
