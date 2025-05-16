import json
import torch
from transformers import AutoTokenizer, AutoModel

def main():
    # Set the device for inference
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    # Choose the ModernBERT-base model (adjust the model id if needed)
    model_name = "answerdotai/ModernBERT-base"
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModel.from_pretrained(model_name)
    model.to(device)
    model.eval()  # Set model in evaluation mode

    # Load the JSON file containing research abstracts
    input_filename = "init.json"
    output_filename = "init_precomputed.json"

    with open(input_filename, "r", encoding="utf-8") as f:
        data = json.load(f)

    # For each entry, compute the embedding for the abstract.
    # Here we extract the representation from the pooled output (if available),
    # otherwise we use the first token of the last hidden state.
    for idx, entry in enumerate(data):
        abstract = entry.get("abstract", "")
        if not abstract:
            # If the abstract is empty or missing, skip (or handle as needed)
            entry["embedding"] = None
            continue

        # Tokenize the abstract. We set truncation as needed.
        inputs = tokenizer(abstract, return_tensors="pt", truncation=True, max_length=8192, padding=True)
        # Send input tensors to the appropriate device
        inputs = {key: value.to(device) for key, value in inputs.items()}

        # Run the model in no_grad mode for efficiency.
        with torch.no_grad():
            outputs = model(**inputs)
            # Prefer pooled_output if it exists
            if hasattr(outputs, "pooler_output") and outputs.pooler_output is not None:
                vector = outputs.pooler_output[0]
            else:
                # Alternatively, use the first token's output from the last hidden state.
                vector = outputs.last_hidden_state[0, 0, :]

        # Convert the resulting tensor to a list (of floats) for JSON serialization.
        embedding = vector.cpu().tolist()
        entry["embedding"] = embedding

        # Optional: print progress every 10 entries
        if (idx + 1) % 10 == 0:
            print(f"Processed {idx + 1} abstracts.")

    # Write out the modified data with the embeddings to a new file.
    with open(output_filename, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    print(f"Precomputed embeddings added and saved to {output_filename}")

if __name__ == "__main__":
    main()
