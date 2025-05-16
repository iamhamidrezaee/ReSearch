#!/usr/bin/env python3
"""
app.py  –  ReSearch API & visualisations
Disk-footprint-optimised version (float16-on-disk, gzip, no-functionality-loss)
"""

# ── Standard lib ──────────────────────────────────────────────────────────────
import gzip
import hashlib
import json
import os
import random
import time
import lzma
from pathlib import Path

# ── Third-party ───────────────────────────────────────────────────────────────
import numpy as np
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from scipy import sparse
from scipy.sparse import csr_matrix
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import normalize

# ── Local helpers ─────────────────────────────────────────────────────────────
import cossim as cos
from paper_similarity import SimilarityMatrix   # unchanged local import

# SVD compression utility
class SVDCompressor:
    """
    Utility class to compress/decompress TruncatedSVD models by splitting them
    into components and using appropriate compression for each part.
    """
    
    @staticmethod
    def compress_svd_model(svd_model, output_path, compression_level=9):
        """
        Compresses a TruncatedSVD model into a smaller file by:
        1. Extracting the key components
        2. Converting large arrays to float16 
        3. Using LZMA compression with highest level
        
        Args:
            svd_model: The fitted TruncatedSVD model
            output_path: Path to save the compressed model
            compression_level: LZMA compression level (0-9)
        """
        import pickle
        import lzma
        import numpy as np
        import os
        
        # Extract critical components
        svd_components = {
            'components_': svd_model.components_.astype(np.float16),
            'singular_values_': svd_model.singular_values_.astype(np.float32),
            'explained_variance_': svd_model.explained_variance_.astype(np.float32),
            'explained_variance_ratio_': svd_model.explained_variance_ratio_.astype(np.float32),
            'n_components': svd_model.n_components,
            'n_features_in_': svd_model.n_features_in_,  # Fixed: use n_features_in_ attribute
            'algorithm': svd_model.algorithm,
            'random_state': svd_model.random_state
        }
        
        # Create output directory if it doesn't exist
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        
        # Save with LZMA compression (highest level)
        with lzma.open(output_path, 'wb', preset=compression_level) as f:
            pickle.dump(svd_components, f)
            
        print(f"Compressed SVD model saved to {output_path}")
        print(f"File size: {os.path.getsize(output_path) / (1024 * 1024):.2f} MB")
        
    @staticmethod
    def load_compressed_svd_model(input_path):
        """
        Loads a compressed SVD model and reconstructs it.
        
        Args:
            input_path: Path to the compressed model file
            
        Returns:
            Reconstructed TruncatedSVD model
        """
        import pickle
        import lzma
        import numpy as np
        from sklearn.decomposition import TruncatedSVD
        
        # Load the compressed components
        with lzma.open(input_path, 'rb') as f:
            svd_components = pickle.load(f)
        
        # Create a new SVD model
        svd_model = TruncatedSVD(
            n_components=svd_components['n_components'],
            algorithm=svd_components['algorithm'],
            random_state=svd_components['random_state']
        )
        
        # Set the fitted attributes
        svd_model.components_ = svd_components['components_'].astype(np.float64)
        svd_model.singular_values_ = svd_components['singular_values_'].astype(np.float64)
        svd_model.explained_variance_ = svd_components['explained_variance_'].astype(np.float64)
        svd_model.explained_variance_ratio_ = svd_components['explained_variance_ratio_'].astype(np.float64)
        svd_model.n_features_in_ = svd_components['n_features_in_']  # Fixed: use n_features_in_ attribute
        
        return svd_model

# ──────────────────────────────────────────────────────────────────────────────
# Global config – **only new constant is DTYPE_ON_DISK**
# ──────────────────────────────────────────────────────────────────────────────
DTYPE_ON_DISK = np.float16          # all heavy matrices saved as half precision
SVD_COMPONENTS = 100                # keep quality; still small on disk
SPARSE_DTYPE_ON_DISK = np.float32       # <─ NEW  (was float16)
DENSE_DTYPE_ON_DISK  = np.float16       # unchanged for doc vectors

# for convenience everywhere else
ROOT_PATH = Path(os.path.abspath(os.path.join("..", os.curdir)))
os.environ["ROOT_PATH"] = str(ROOT_PATH)

# ── Load raw paper JSON ───────────────────────────────────────────────────────
current_directory = Path(__file__).resolve().parent
json_file_path = current_directory / "init.json"

try:
    print(f"[load] {json_file_path}")
    with open(json_file_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    print(f"[load] ✓  {len(data):,} papers")
except Exception as exc:
    print(f"[error] loading JSON – {exc}")
    data = []

# Tokenise once so we can build an inverted index later
for doc in data:
    doc["toks"] = cos.tokenize(doc.get("abstract", ""))

inv_index = cos.build_inverted_index(data)

# ── Flask setup ───────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

# ── Disk cache locations ──────────────────────────────────────────────────────
precompute_dir = current_directory / "precomputed"
precompute_dir.mkdir(exist_ok=True)

vectorizer_path       = precompute_dir / "tfidf_vectorizer.pkl.gz"
tfidf_matrix_path     = precompute_dir / "tfidf_matrix_fp16.npz"
svd_path              = precompute_dir / "svd_model.xz"  # Use XZ as primary path
old_svd_path          = precompute_dir / "svd_model.pkl.gz"  # Keep reference to old path
docvecs_path          = precompute_dir / "doc_vectors_fp16.npz"
similarities_path     = precompute_dir / "similarities.pkl.gz"
data_hash_path        = precompute_dir / "data_hash.txt"

# ── Decide whether we must (re)build ──────────────────────────────────────────
data_hash = hashlib.md5(
    json.dumps([{"title": d["title"], "abstract": d["abstract"]} for d in data])
    .encode()
).hexdigest()

need_recompute = True
if (
    all(p.exists() for p in (vectorizer_path,
                             tfidf_matrix_path,
                             docvecs_path,
                             similarities_path,
                             data_hash_path)) and
    (svd_path.exists() or old_svd_path.exists())  # Check for either SVD file
):
    if data_hash_path.read_text().strip() == data_hash:
        need_recompute = False

# ── (Re)compute & save ────────────────────────────────────────────────────────
# Add this function to your app.py

def cleanup_old_svd_files(precompute_dir):
    """
    Clean up old SVD model files once the new compressed version is confirmed to work.
    Removes .pkl.gz files if corresponding .xz files exist and are valid.
    
    Args:
        precompute_dir: Path to the precomputed directory
    """
    import os
    from pathlib import Path
    
    # Check for old SVD model file
    old_svd_path = precompute_dir / "svd_model.pkl.gz"
    new_svd_path = precompute_dir / "svd_model.xz"
    
    if old_svd_path.exists() and new_svd_path.exists():
        # Validate that the new file is working before removing the old one
        try:
            # Try to load the model from the new file to verify it works
            svd = SVDCompressor.load_compressed_svd_model(new_svd_path)
            
            # If we got here, the new file is valid - we can remove the old one
            old_size_mb = old_svd_path.stat().st_size / (1024 * 1024)
            new_size_mb = new_svd_path.stat().st_size / (1024 * 1024)
            
            # Remove the old file
            old_svd_path.unlink()
            
            print(f"Removed old SVD model file ({old_size_mb:.2f} MB)")
            print(f"Now using compressed version only ({new_size_mb:.2f} MB)")
            print(f"Space saved: {old_size_mb - new_size_mb:.2f} MB")
            
        except Exception as e:
            print(f"Error validating new SVD model, keeping old file as backup: {e}")

if need_recompute:
    print("[build] Computing TF-IDF / SVD …")
    texts = [f"{d.get('title','')} {d.get('abstract','')}" for d in data]

    # 1) TF-IDF  (keep as float32)
    vectorizer = TfidfVectorizer(
        stop_words="english",
        max_df=0.7,
        min_df=1,
        ngram_range=(1, 2),
    )
    tfidf_matrix = vectorizer.fit_transform(texts).astype(SPARSE_DTYPE_ON_DISK)

    # 2) SVD  (doc vectors saved as fp16)
    svd = TruncatedSVD(n_components=SVD_COMPONENTS, random_state=42)
    doc_vectors = svd.fit_transform(tfidf_matrix.astype(np.float32))
    doc_vectors = normalize(doc_vectors, axis=1).astype(DENSE_DTYPE_ON_DISK)

    # 3) Nearest neighbours for pre-computed similarity list
    nn = NearestNeighbors(n_neighbors=16, metric="cosine", algorithm="brute")
    nn.fit(doc_vectors.astype(np.float32))
    dist, idx = nn.kneighbors(doc_vectors)
    paper_similarities = []
    for row_i, (row_idx, row_dist) in enumerate(zip(idx[:, 1:], dist[:, 1:])):
        sims = []
        for j, d_ in zip(row_idx, row_dist):
            sims.append(
                {
                    "id": j,
                    "original_id": j,
                    "title": data[j]["title"],
                    "abstract": (data[j]["abstract"][:200] + " …")
                    if len(data[j]["abstract"]) > 200
                    else data[j]["abstract"],
                    "link": data[j]["link"],
                    "score": float(1 - d_),
                }
            )
        paper_similarities.append(sims[:15])

    # ── Save (all in gzip / compressed fp16) ────────────────────────────────
    with gzip.open(vectorizer_path, "wb", compresslevel=9) as fh:
        import pickle

        pickle.dump(vectorizer, fh)

    sparse.save_npz(tfidf_matrix_path, tfidf_matrix)  # already fp16
    
    # Use SVDCompressor instead of regular pickle+gzip
    SVDCompressor.compress_svd_model(svd, svd_path, compression_level=9)

    np.savez_compressed(docvecs_path, doc_vectors)  # fp16

    with gzip.open(similarities_path, "wb", compresslevel=9) as fh:
        pickle.dump(paper_similarities, fh)

    data_hash_path.write_text(data_hash)
    print("[build] ✓  pre-compute finished & cached")
else:
    print("[load] Using pre-computed artefacts")

    import pickle

    with gzip.open(vectorizer_path, "rb") as fh:
        vectorizer = pickle.load(fh)

    # IMPORTANT: cast back to float32 for sklearn math
    tfidf_matrix = (
        sparse.load_npz(tfidf_matrix_path)
        .astype(np.float32)                 # make sure it's float32 in RAM
    )

    # Use SVDCompressor to load the model
    svd = SVDCompressor.load_compressed_svd_model(svd_path)

    doc_vectors = (
        np.load(docvecs_path)["arr_0"].astype(np.float32)
    )
    with gzip.open(similarities_path, "rb") as fh:
        paper_similarities = pickle.load(fh)

    # ensure unit-norm (cast might disturb it a hair)
    doc_vectors = normalize(doc_vectors, axis=1)
    
    # Clean up old files if they exist
    cleanup_old_svd_files(precompute_dir)

# alias used throughout old code
document_vectors_normalized = doc_vectors


# ──────────────────────────────────────────────────────────────────────────────

@app.route("/")
def home():
    return render_template('base.html', title="ReSearch")

def modified_sigmoid(x):
    """
    Modified sigmoid function with logarithmic transformation
    optimized for range tens–hundreds of thousands mapping to 0.5–0.9
    with better sensitivity in the lower ranges.
    """
    a = 0.2979
    b = -1.2902
    # avoid log(0)
    return 1 / (1 + np.exp(-(a * np.log(x + 1) + b)))

@app.route("/search")
def search():
    query = request.args.get("query", "").strip()
    if not query:
        return jsonify([])

    # 1) exact title match check
    exact = [doc for doc in data if doc.get("title", "").lower() == query.lower()]
    if exact:
        # return exact match at top
        doc = exact[0].copy()
        doc["score"] = 1.0
        return jsonify(convert_to_serializable([doc]))

    try:
        # transform query into TF-IDF
        query_tfidf = vectorizer.transform([query])
        if query_tfidf.nnz == 0:
            # fallback keyword scan
            lowq = query.lower()
            hits = []
            for doc in data:
                if lowq in doc.get("title", "").lower() or lowq in doc.get("abstract", "").lower():
                    hits.append(doc)
                    if len(hits) >= 5:
                        break
            return jsonify(convert_to_serializable(hits))

        # 2) get TF-IDF cosine scores
        from sklearn.metrics.pairwise import cosine_similarity
        tfidf_scores = cosine_similarity(query_tfidf, tfidf_matrix).flatten()

        # 3) narrow down to top K by TF-IDF
        K = 50
        top_idxs = np.argsort(tfidf_scores)[::-1][:K]

        # 4) compute SVD-based similarity on those K
        query_svd = svd.transform(query_tfidf)
        query_norm = normalize(query_svd)[0]  # shape (n_components,)
        candidates = document_vectors_normalized[top_idxs]  # (K, n_components)
        svd_scores = candidates.dot(query_norm)

        # 5) combine lexical + latent
        alpha = 0.8
        combined = alpha * tfidf_scores[top_idxs] + (1 - alpha) * svd_scores

        # 6) boost by citation count
        boost_factor = 0.2
        boosted = []
        for idx_pos, doc_idx in enumerate(top_idxs):
            base_score = combined[idx_pos]
            cite_cnt = data[doc_idx].get("citation_count", 0)
            boost = modified_sigmoid(cite_cnt)
            # final = base * (1 + boost_factor * (boost - 0.5))
            final_score = base_score * (1 + boost_factor * min(0,(boost - 0.5)) * 2)
            boosted.append((doc_idx, final_score))

        # 7) pick top N results
        N = 7
        best = sorted(boosted, key=lambda x: x[1], reverse=True)[:N]

        # 8) build result list
        results = []
        for idx, score in best:
            doc = data[idx].copy()
            doc["score"] = float(score)
            results.append(doc)

        print(f"Search returned {len(results)} results")
    except Exception as e:
        print(f"Error during search: {e}")
        results = []

    return jsonify(convert_to_serializable(results))

@app.route("/map")
def paper_map():
    """Render the paper map visualization page"""
    return render_template('map.html', title="ReSearch Paper Map")

@app.route("/map_data")
def map_data():
    query = request.args.get("query", "")
    if not query:
        return jsonify({"center": None, "related": []})
    
    try:
        # First, check for exact title matches before any transformation
        exact_match_idx = None
        for idx, paper in enumerate(data):
            if paper.get("title", "").lower() == query.lower():
                exact_match_idx = idx
                break
        
        # If we found an exact match, use that paper as the center
        if exact_match_idx is not None:
            center_paper = data[exact_match_idx]
            
            # Get related papers from precomputed similarities
            related_papers = []
            if exact_match_idx < len(paper_similarities):
                similar_papers = paper_similarities[exact_match_idx]
                
                # Add citation counts to related papers
                for similar_paper in similar_papers:
                    similar_id = similar_paper.get("original_id")
                    if similar_id is not None and similar_id >= 0 and similar_id < len(data):
                        # Add citation count from original data
                        similar_paper["citations"] = data[similar_id].get("citation_count", 0)
                
                related_papers = similar_papers
            
            # Format data for visualization
            map_data = {
                "center": {
                    "id": 0,
                    "original_id": exact_match_idx,
                    "title": center_paper.get("title", "Unknown"),
                    "abstract": center_paper.get("abstract", ""),
                    "link": center_paper.get("link", ""),
                    "score": 1.0,  # Main paper has highest score
                    "citations": center_paper.get("citation_count", 0)
                },
                "related": related_papers
            }
            
            # Convert any NumPy types to Python standard types for JSON serialization
            map_data = convert_to_serializable(map_data)
            return jsonify(map_data)
        
        # If no exact match, continue with the original logic
        # Transform query to TF-IDF
        query_tfidf = vectorizer.transform([query])
        if query_tfidf.sum() == 0:
            return jsonify({"center": None, "related": []})
        
        # Project to SVD space and normalize
        query_svd = svd.transform(query_tfidf)
        query_normalized = normalize(query_svd)
        
        # Compute similarities
        scores = query_normalized @ document_vectors_normalized.T
        top_indices = np.argsort(scores[0])[::-1][:5]
        results = [data[i] for i in top_indices]
        
        if not results or len(results) == 0:
            return jsonify({"center": None, "related": []})
        
        # Main paper is the top search result
        center_paper = results[0]
        
        # Find the index of this paper in the original data
        center_index = None
        for i, paper in enumerate(data):
            if paper.get("title") == center_paper.get("title"):
                center_index = i
                break
        
        # Get related papers from precomputed similarities
        related_papers = []
        if center_index is not None and center_index < len(paper_similarities):
            # Get the similarity data for this paper
            similar_papers = paper_similarities[center_index]
            
            # Add citation counts to existing related papers
            for similar_paper in similar_papers:
                similar_id = similar_paper.get("original_id")
                if similar_id is not None and similar_id >= 0 and similar_id < len(data):
                    # Add citation count from the original data
                    similar_paper["citations"] = data[similar_id].get("citation_count", 0)
            
            related_papers = similar_papers
            
        else:
            # Fallback: use next top search results
            for i, paper in enumerate(results[1:16], 1):  # Limit to 15 related papers
                related_papers.append({
                    "id": i,
                    "original_id": -1,  # No original ID for search results
                    "title": paper.get("title", "Unknown"),
                    "abstract": paper.get("abstract", ""),
                    "link": paper.get("link", ""),
                    "score": max(0.3, 1.0 - (i * 0.05)),  # Decreasing score
                    "citations": paper.get("citation_count", 0)  # Use current paper's citation count
                })
        
        # Format data for the visualization
        map_data = {
            "center": {
                "id": 0,
                "original_id": center_index,
                "title": center_paper.get("title", "Unknown"),
                "abstract": center_paper.get("abstract", ""),
                "link": center_paper.get("link", ""),
                "score": 1.0,  # Main paper has highest score
                "citations": center_paper.get("citation_count", 0)
            },
            "related": related_papers
        }
        
        # Convert any NumPy types to Python standard types for JSON serialization
        map_data = convert_to_serializable(map_data)
        
        return jsonify(map_data)
    except Exception as e:
        print(f"Error generating map data: {str(e)}")
        return jsonify({"center": None, "related": [], "error": str(e)})
    
def convert_to_serializable(obj):
    """
    Convert numpy types to Python standard types for JSON serialization
    """
    import numpy as np
    if isinstance(obj, (np.int_, np.intc, np.intp, np.int8, np.int16, np.int32, np.int64,
                         np.uint8, np.uint16, np.uint32, np.uint64)):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, dict):
        return {convert_to_serializable(k): convert_to_serializable(v) for k, v in obj.items()}
    elif isinstance(obj, list) or isinstance(obj, tuple):
        return [convert_to_serializable(i) for i in obj]
    else:
        return obj

@app.route("/paper_as_query")
def paper_as_query():
    """API endpoint to use a specific paper as the query center"""
    paper_id_str = request.args.get("paper_id", "")
    
    try:
        paper_id = int(paper_id_str)
        print(f"Using paper ID {paper_id} as query center")
        
        if paper_id < 0 or paper_id >= len(data):
            print(f"Invalid paper ID: {paper_id}")
            return jsonify({"center": None, "related": [], "error": "Invalid paper ID"})
        
        start_time = time.time()
        
        # Get the center paper data
        center_paper = data[paper_id]
        
        # Get related papers directly from the precomputed similarity matrix
        related_papers = []
        if paper_id < len(paper_similarities):
            # Get the similarity data for this paper
            similar_papers = paper_similarities[paper_id]
            
            for i, similar_paper in enumerate(similar_papers):
                original_id = similar_paper.get("original_id")
                citation_count = 0
                
                # Get citation count from the original data
                if original_id is not None and original_id >= 0 and original_id < len(data):
                    citation_count = data[original_id].get("citation_count", 0)
                
                # Include the original ID for reference
                related_papers.append({
                    "id": i + 1,  # ID for visualization (1-based)
                    "original_id": original_id,
                    "title": similar_paper.get("title"),
                    "abstract": similar_paper.get("abstract"),
                    "link": similar_paper.get("link"),
                    "score": similar_paper.get("score"),
                    "citations": citation_count
                })
        
        # Format data for the visualization
        map_data = {
            "center": {
                "id": 0,
                "original_id": paper_id,
                "title": center_paper.get("title", "Unknown"),
                "abstract": center_paper.get("abstract", ""),
                "link": center_paper.get("link", ""),
                "score": 1.0,  # Main paper has highest score
                "citations": center_paper.get("citation_count", 0)
            },
            "related": related_papers
        }
        
        end_time = time.time()
        print(f"Paper-as-query map data generated in {end_time - start_time:.2f} seconds")
        
        map_data = convert_to_serializable(map_data)
        return jsonify(map_data)
    except ValueError:
        print(f"Invalid paper ID format: {paper_id_str}")
        return jsonify({"center": None, "related": [], "error": "Invalid paper ID format"})
    except Exception as e:
        print(f"Error generating paper-as-query map: {str(e)}")
        return jsonify({"center": None, "related": [], "error": str(e)})

@app.route("/team")
def team():
    return render_template('team.html', title="ReSearch Team")
    
@app.route("/explore")
def explore():
    """Render the research explore visualization page"""
    return render_template('explore.html', title="ReSearch Galaxy Explorer")

@app.route("/explore_data")
def explore_data():
    """API endpoint for explore visualization data"""
    try:
        start_time = time.time()
        
        # Get the maxPapers parameter from the request, default to 200 if not provided
        max_papers = request.args.get("maxPapers", 200, type=int)
        # Ensure we have a reasonable range
        max_papers = max(50, min(max_papers, 500))  # Limit between 50 and 500
        
        print(f"Using maxPapers value: {max_papers}")
        
        # Find hub and authority papers first (to prioritize them)
        # Process all papers to find potential hub-authority relationships
        all_citation_network = process_citation_network(data)
        
        # Get indices of all hub and authority papers (from the original dataset)
        all_hub_indices = [hub["index"] for hub in all_citation_network["hubs"]]
        all_authority_indices = [auth["index"] for auth in all_citation_network["authorities"]]
        
        # Prioritize hub and authority papers for inclusion
        prioritized_indices = list(set(all_hub_indices + all_authority_indices))
        
        # Ensure we don't exceed maxPapers with just the hub/authority papers
        prioritized_indices = prioritized_indices[:max_papers]
        
        # Calculate remaining slots
        remaining_slots = max_papers - len(prioritized_indices)
        
        # Group papers by tag for balanced sampling of the remaining slots
        papers_by_tag = {}
        for i, paper in enumerate(data):
            # Skip if already included as hub/authority
            if i in prioritized_indices:
                continue
                
            tag = paper.get("tag", "general")
            if tag not in papers_by_tag:
                papers_by_tag[tag] = []
            papers_by_tag[tag].append((i, paper))
        
        # Sample papers from each tag for the remaining slots
        sampled_indices = list(prioritized_indices)  # Start with prioritized papers
        
        if remaining_slots > 0 and len(papers_by_tag) > 0:
            # Calculate papers per tag for remaining slots
            total_tags = len(papers_by_tag)
            base_papers_per_tag = remaining_slots // total_tags
            
            # Distribute papers across tags
            remaining = remaining_slots
            for tag, tag_papers in papers_by_tag.items():
                # Take either all papers in this tag or the fair allocation amount
                take_count = min(len(tag_papers), base_papers_per_tag)
                # Sort by citation count within each tag to prioritize important papers
                tag_papers.sort(key=lambda x: x[1].get("citation_count", 0), reverse=True)
                tag_samples = tag_papers[:take_count]
                sampled_indices.extend([i for i, _ in tag_samples])
                remaining -= take_count
            
            # If we still have slots remaining, fill with papers from any tag (prioritizing by citation count)
            if remaining > 0:
                all_remaining = []
                for tag, tag_papers in papers_by_tag.items():
                    all_remaining.extend([(i, p) for i, p in tag_papers if i not in sampled_indices])
                
                # Sort remaining by citation count
                all_remaining.sort(key=lambda x: x[1].get("citation_count", 0), reverse=True)
                
                # Add remaining papers
                for i, _ in all_remaining[:remaining]:
                    if i not in sampled_indices:
                        sampled_indices.append(i)
        
        # If algorithm failed or there are no tags, fall back to simple sampling
        if not sampled_indices:
            sampled_indices = list(range(min(max_papers, len(data))))
        
        # Ensure we don't exceed maxPapers
        sampled_indices = sampled_indices[:max_papers]
        
        # Get the sampled papers
        sampled_papers = [data[i] for i in sampled_indices]
        
        # Process citation network to find hubs and authorities
        citation_network = process_citation_network(sampled_papers)
        
        # Create lookup sets for quick checking
        hub_indices = {hub["index"] for hub in citation_network["hubs"]}
        authority_indices = {auth["index"] for auth in citation_network["authorities"]}
        
        # Prepare paper data for visualization
        papers = []
        for i, paper in enumerate(sampled_papers):
            # Check for required fields and set defaults if missing
            title = paper.get("title", "Untitled Paper")
            abstract = paper.get("abstract", "No abstract available")
            link = paper.get("link", "#")
            citations = paper.get("citation_count", random.randint(0, 100))
            
            # Determine if this paper is a hub or authority
            is_hub = i in hub_indices
            is_authority = i in authority_indices
            
            # Create a paper object with the fields needed by the visualization
            paper_obj = {
                "id": f"paper-{i}",
                "title": title,
                "abstract": abstract,
                "authors": paper.get("authors", "Unknown Author"),
                "year": paper.get("year", 2023),
                "citations": citations,
                "link": link,
                "cluster": determine_cluster(title, abstract, paper.get("tag", "")),
                "readingLevel": determine_reading_level(abstract),
                "related": [],
                "isHub": is_hub,
                "isAuthority": is_authority,
                "tag": paper.get("tag", "general"),
                "originalIndex": i  # Store the original index for edge mapping
            }
            
            papers.append(paper_obj)
        
        # Add related papers based on hub-authority relationships first, then similarity
        for i, paper in enumerate(papers):
            related_ids = set()  # Use a set to avoid duplicates
            
            # First add hub-authority relationships
            for edge in citation_network["edges"]:
                if edge["source"] == paper["originalIndex"]:
                    related_ids.add(f"paper-{edge['target']}")
                elif edge["target"] == paper["originalIndex"]:
                    related_ids.add(f"paper-{edge['source']}")
            
            # Then supplement with similarity relationships if needed
            orig_index = sampled_indices[i]
            if len(related_ids) < 3 and orig_index < len(paper_similarities):
                # Get similar papers
                similar_papers = paper_similarities[orig_index][:5]  # Limit to top 5 for simplicity
                
                for similar in similar_papers:
                    similar_id = similar.get("original_id")
                    # Convert original ID to the ID in our sampled set
                    if similar_id is not None and similar_id in sampled_indices:
                        sampled_idx = sampled_indices.index(similar_id)
                        related_id = f"paper-{sampled_idx}"
                        if related_id not in related_ids:  # Avoid duplicates
                            related_ids.add(related_id)
                            if len(related_ids) >= 5:  # Limit to 5 relations total
                                break
            
            paper["related"] = list(related_ids)
        
        # Add hub-authority edges explicitly
        hub_authority_links = []
        for edge in citation_network["edges"]:
            hub_authority_links.append({
                "source": f"paper-{edge['source']}",
                "target": f"paper-{edge['target']}",
                "type": "citation"
            })
        
        # Create guided journeys (limited to 5)
        all_journeys = create_guided_journeys(papers)
        # Select only the top 3 journeys
        journeys = select_top_journeys(all_journeys, 3)
        
        # Format data for the visualization
        explore_data = {
            "papers": papers,
            "journeys": journeys,
            "hubAuthorityLinks": hub_authority_links
        }
        
        end_time = time.time()
        print(f"Explore data generated in {end_time - start_time:.2f} seconds with {len(papers)} papers and {len(journeys)} journeys")
        
        explore_data = convert_to_serializable(explore_data)
        return jsonify(explore_data)
    except Exception as e:
        print(f"Error generating explore data: {str(e)}")
        return jsonify({"papers": [], "journeys": [], "error": str(e)})
    
def select_top_journeys(journeys, max_count=5):
    """
    Select a diverse set of top journeys, limited to max_count
    
    Strategy:
    1. Prioritize journeys with hub-authority papers
    2. Ensure diversity across clusters
    3. Ensure diversity across journey types
    4. If still more than max_count, prioritize by citation counts of included papers
    """
    if not journeys or len(journeys) <= max_count:
        return journeys
    
    # Step 1: Score each journey
    for journey in journeys:
        # Initialize score (will be used for final ranking)
        journey['score'] = 0
        
        # Check if title contains "Citation Influence" (hub-authority journey)
        if "Influencial Papers" in journey.get('title', ''):
            journey['score'] += 10  # Highest priority
        
        # Bonus for recent developments
        if "Recent Advances" in journey.get('title', ''):
            journey['score'] += 5
            
        # Bonus for evolution journeys
        if "Evolution" in journey.get('title', ''):
            journey['score'] += 3
    
    # Step 2: Ensure cluster diversity by picking top journey from each cluster
    selected_journeys = []
    clusters_selected = set()
    
    # Sort by score (highest first)
    sorted_journeys = sorted(journeys, key=lambda j: j.get('score', 0), reverse=True)
    
    # First pass: Select one journey from each cluster (until max_count is reached)
    for journey in sorted_journeys:
        cluster = journey.get('domain')
        if cluster not in clusters_selected and len(selected_journeys) < max_count:
            selected_journeys.append(journey)
            clusters_selected.add(cluster)
    
    # If we still have room, add more journeys based on score
    remaining_slots = max_count - len(selected_journeys)
    if remaining_slots > 0:
        # Get journeys not already selected
        remaining_journeys = [j for j in sorted_journeys if j not in selected_journeys]
        # Add top scoring remaining journeys
        selected_journeys.extend(remaining_journeys[:remaining_slots])
    
    # Ensure we don't exceed max_count
    return selected_journeys[:max_count]
  
def determine_cluster(title, abstract, tag=""):
    """Determine the research domain/cluster for a paper based on its title, abstract, and tag"""
    # First check if the tag directly maps to a cluster
    tag_mapping = {
        "transformer": "NLP",
        "nlp": "NLP",
        "cv": "Computer Vision",
        "rl": "Reinforcement Learning",
        "dl": "Machine Learning",
        "gan": "Generative Models",
        "ai": "Machine Learning"
    }
    
    if tag and tag.lower() in tag_mapping:
        return tag_mapping[tag.lower()]
    
    combined_text = (title + " " + abstract).lower()
    
    # Specific model names detection
    if "transformer" in combined_text or "attention is all you need" in combined_text:
        return "NLP"
    elif "elmo" in combined_text or "deep contextualized word" in combined_text:
        return "NLP"
    elif "xlnet" in combined_text or "bert" in combined_text or "gpt" in combined_text:
        return "NLP"
    elif "policy gradient" in combined_text:
        return "Reinforcement Learning"
    
    # General domain detection
    if "machine learning" in combined_text or "neural network" in combined_text:
        return "Machine Learning"
    elif "computer vision" in combined_text or "image" in combined_text:
        return "Computer Vision"
    elif "natural language" in combined_text or "nlp" in combined_text or "language model" in combined_text:
        return "NLP"
    elif "reinforcement" in combined_text or "reward" in combined_text:
        return "Reinforcement Learning"
    elif "generative" in combined_text or "gan" in combined_text or "diffusion" in combined_text:
        return "Generative Models"
    else:
        # Fallback to one of the domains based on a hash of the title
        # but make it deterministic so the same paper always gets the same cluster
        domains = ["Machine Learning", "Computer Vision", "NLP", "Reinforcement Learning", "Generative Models"]
        hash_value = hash(title) % len(domains)
        return domains[hash_value]

def determine_reading_level(abstract):
    """Determine the reading complexity of a paper"""
    words = abstract.split()
    if not words:
        return "Introductory"
    
    avg_word_length = sum(len(word) for word in words) / len(words)
    
    if avg_word_length > 7:
        return "Advanced"
    elif avg_word_length > 5.5:
        return "Intermediate"
    else:
        return "Introductory"

def create_guided_journeys(papers):
    """Create diverse guided journeys through papers based on multiple criteria"""
    # Group papers by cluster and tag
    clusters = {}
    for paper in papers:
        cluster = paper["cluster"]
        tag = paper.get("tag", "general")
        
        if cluster not in clusters:
            clusters[cluster] = {}
        
        if tag not in clusters[cluster]:
            clusters[cluster][tag] = []
        
        clusters[cluster][tag].append(paper)
    
    # Initialize journey data
    journeys = []
    processed_combinations = set()  # Track cluster+tag combinations to avoid duplicates
    
    # Journey templates by research domain
    journey_descriptions = {
        "Machine Learning": {
            "title": "Introduction to ML Fundamentals",
            "description": "A curated path through essential machine learning concepts and algorithms for beginners.",
            "class": "ml"
        },
        "Computer Vision": {
            "title": "Computer Vision Breakthrough Papers",
            "description": "Explore the most influential papers that revolutionized computer vision techniques.",
            "class": "cv"
        },
        "NLP": {
            "title": "NLP Evolution: From RNNs to Transformers",
            "description": "Follow the evolution of natural language processing from recurrent networks to transformer architectures.",
            "class": "nlp"
        },
        "Reinforcement Learning": {
            "title": "Foundations of Reinforcement Learning",
            "description": "Understand the core principles and algorithms behind reinforcement learning.",
            "class": "rl"
        },
        "Generative Models": {
            "title": "Generative AI Revolution",
            "description": "Discover the papers that led to today's powerful generative AI systems.",
            "class": "gen"
        }
    }
    
    journey_id = 1
    
    # Create different types of journeys
    for cluster, tags in clusters.items():
        for tag, tag_papers in tags.items():
            # Skip if not enough papers
            if len(tag_papers) < 3:
                continue
                
            # Create a key to track this combination
            combo_key = f"{cluster}:{tag}"
            if combo_key in processed_combinations:
                continue
                
            processed_combinations.add(combo_key)
            
            journey_info = journey_descriptions.get(cluster, {
                "title": f"Journey through {cluster}",
                "description": f"Explore important papers in {cluster}.",
                "class": cluster.lower()[:2]
            })
            
            # Create different journey types based on available data
            
            # 1. High Impact Papers Journey (sort by citations)
            if len(tag_papers) >= 3:
                citation_sorted = sorted(tag_papers, key=lambda p: p.get("citations", 0), reverse=True)
                high_impact_papers = citation_sorted[:min(5, len(citation_sorted))]
                
                title = f"{journey_info['title']}: {tag.upper()}"
                description = f"The most influential and highly-cited papers in {cluster}"
                
                journeys.append({
                    "id": f"journey-{journey_id}",
                    "title": title,
                    "description": description,
                    "domain": cluster,
                    "tag": tag,
                    "steps": [p["id"] for p in high_impact_papers],
                    "class": journey_info["class"]
                })
                
                journey_id += 1
            
            # 2. Chronological Evolution Journey (sort by year)
            if len(tag_papers) >= 4:
                # Only include papers with years
                year_papers = [p for p in tag_papers if p.get("year")]
                if len(year_papers) >= 4:
                    year_sorted = sorted(year_papers, key=lambda p: p.get("year", "2000"))
                    evolution_papers = year_sorted[:min(5, len(year_sorted))]
                    
                    title = f"Evolution of {cluster}: {tag.upper()}"
                    description = f"Track how {cluster} research in this has evolved over time."
                    
                    journeys.append({
                        "id": f"journey-{journey_id}",
                        "title": title,
                        "description": description,
                        "domain": cluster,
                        "tag": tag,
                        "steps": [p["id"] for p in evolution_papers],
                        "class": journey_info["class"]
                    })
                    
                    journey_id += 1
            
            # 3. Hub-Authority Path Journey (if hubs and authorities present)
            hub_papers = [p for p in tag_papers if p.get("isHub")]
            authority_papers = [p for p in tag_papers if p.get("isAuthority")]
            
            if hub_papers and authority_papers and len(hub_papers) + len(authority_papers) >= 3:
                # Create a journey mixing hubs and authorities
                hub_auth_path = []
                
                # Start with a hub
                hub_auth_path.extend(hub_papers[:min(2, len(hub_papers))])
                
                # Add authorities
                hub_auth_path.extend(authority_papers[:min(3, len(authority_papers))])
                
                # Ensure we have enough papers in the path
                if len(hub_auth_path) < 3:
                    # Add more papers by citation count
                    remaining_papers = [p for p in tag_papers if p not in hub_auth_path]
                    citation_sorted = sorted(remaining_papers, key=lambda p: p.get("citations", 0), reverse=True)
                    hub_auth_path.extend(citation_sorted[:min(5 - len(hub_auth_path), len(citation_sorted))])
                
                # Limit to 5 papers
                hub_auth_path = hub_auth_path[:5]
                
                title = f"Citation Influence: {tag.upper()}"
                description = f"Explore the network of influential and authoritative papers in {cluster}."
                
                journeys.append({
                    "id": f"journey-{journey_id}",
                    "title": title,
                    "description": description,
                    "domain": cluster,
                    "tag": tag,
                    "steps": [p["id"] for p in hub_auth_path],
                    "class": journey_info["class"]
                })
                
                journey_id += 1
            
            # 4. Recent Developments Journey (papers from last 3 years)
            current_year = 2023  # We could get this dynamically
            recent_papers = [p for p in tag_papers if p.get("year") and int(p.get("year", "2000")) >= current_year - 3]
            
            if len(recent_papers) >= 3:
                # Sort by citation count for recent papers
                recent_sorted = sorted(recent_papers, key=lambda p: p.get("citations", 0), reverse=True)
                recent_journey = recent_sorted[:min(3, len(recent_sorted))]
                
                title = f"Recent Advances in {cluster}: {tag.upper()}"
                description = f"Discover the most recent and impactful papers in {cluster}."
                
                journeys.append({
                    "id": f"journey-{journey_id}",
                    "title": title,
                    "description": description,
                    "domain": cluster,
                    "tag": tag,
                    "steps": [p["id"] for p in recent_journey],
                    "class": journey_info["class"]
                })
                
                journey_id += 1
    
    return journeys
    
import networkx as nx
def process_citation_network(papers_data, top_n=10):
    """
    Identify hubs and authorities using the NetworkX HITS algorithm.

    Args:
        papers_data (list): List of paper dicts, each optionally containing a 'cites' list of dicts with 'title'.
        top_n (int): Number of top hubs and authorities to return.

    Returns:
        dict: {'hubs': [...], 'authorities': [...], 'edges': [...]}.
    """
    # Map titles to indices for lookup
    title_to_index = {paper.get('title'): idx for idx, paper in enumerate(papers_data)}

    # Create directed graph
    G = nx.DiGraph()
    G.add_nodes_from(range(len(papers_data)))

    edges = []
    # Add edges from each paper to its cited papers
    for src_idx, paper in enumerate(papers_data):
        for cited in paper.get('cites', []):
            tgt_idx = title_to_index.get(cited.get('title'))
            if tgt_idx is not None:
                # Add edge with weight based on citation count
                G.add_edge(src_idx, tgt_idx)
                edges.append({
                    'source': src_idx,
                    'target': tgt_idx,
                    'type': 'citation',
                })

    # Compute HITS scores
    hubs_scores, auth_scores = nx.hits(G, max_iter=100, tol=1e-8, normalized=True)

    # Select top_n hubs
    top_hubs = sorted(hubs_scores.items(), key=lambda x: x[1], reverse=True)[:top_n]
    hubs = [
        {
            'index': idx,
            'title': papers_data[idx].get('title', 'Untitled Paper'),
            'hub_score': score,
            'citation_count': papers_data[idx].get('citation_count', 0)
        }
        for idx, score in top_hubs
    ]

    # Select top_n authorities
    top_auths = sorted(auth_scores.items(), key=lambda x: x[1], reverse=True)[:top_n]
    authorities = [
        {
            'index': idx,
            'title': papers_data[idx].get('title', 'Untitled Paper'),
            'authority_score': score,
            'citation_count': papers_data[idx].get('citation_count', 0)
        }
        for idx, score in top_auths
    ]

    return {'hubs': hubs, 'authorities': authorities, 'edges': edges}
    
@app.route("/search_papers")
def search_papers():
    """API endpoint for searching papers in the galaxy visualization"""
    query = request.args.get("query", "").strip().lower()
    if not query:
        return jsonify([])
    
    try:
        # Extract papers currently in the galaxy
        galaxy_papers = request.args.get("current_papers", "").split(",")
        galaxy_papers = [paper_id for paper_id in galaxy_papers if paper_id]
        
        # If no current papers specified, search the whole dataset
        if not galaxy_papers:
            results = []
            for i, paper in enumerate(data):
                title = paper.get("title", "").lower()
                abstract = paper.get("abstract", "").lower()
                tag = paper.get("tag", "").lower()
                
                # Check if paper matches query
                if query in title or query in abstract or query in tag:
                    paper_copy = paper.copy()
                    paper_copy["id"] = f"paper-{i}"
                    paper_copy["score"] = 1.0 if query in title else 0.5
                    results.append(paper_copy)
            
            # Sort by score and limit results
            results.sort(key=lambda p: p.get("score", 0), reverse=True)
            results = results[:10]  # Limit to top 10
        else:
            # Search only papers currently in the galaxy
            results = []
            for paper_id in galaxy_papers:
                # Extract the index from paper-X format
                try:
                    if paper_id.startswith("paper-"):
                        index = int(paper_id.split("-")[1])
                        if 0 <= index < len(data):
                            paper = data[index]
                            title = paper.get("title", "").lower()
                            abstract = paper.get("abstract", "").lower()
                            tag = paper.get("tag", "").lower()
                            
                            # Check if paper matches query
                            if query in title or query in abstract or query in tag:
                                paper_copy = paper.copy()
                                paper_copy["id"] = paper_id
                                paper_copy["score"] = 1.0 if query in title else 0.5
                                results.append(paper_copy)
                except:
                    continue
            
            # Sort by score and limit results
            results.sort(key=lambda p: p.get("score", 0), reverse=True)
        
        # Convert for JSON serialization
        return jsonify(convert_to_serializable(results))
    except Exception as e:
        print(f"Error in paper search: {str(e)}")
        return jsonify({"error": str(e)})
    
#  Reinforcement-specific code
@app.route("/reinforce", methods=['POST'])
def reinforce():
    """
    Endpoint to handle paper reinforcement.
    Takes center paper ID and selected paper IDs, returns new cluster data
    with the center paper and papers similar to the selected ones.
    """
    request_data = request.get_json()
    center_id = request_data.get('center_id')
    selected_ids = request_data.get('selected_ids', [])
    
    if center_id is None or not selected_ids:
        return jsonify({"error": "Invalid request data"}), 400
    
    try:
        center_id = int(center_id)
        selected_ids = [int(sid) for sid in selected_ids]
        
        if center_id < 0 or center_id >= len(data) or any(sid < 0 or sid >= len(data) for sid in selected_ids):
            return jsonify({"error": "Invalid paper IDs"}), 400
        
        # Get center paper data
        center_paper = data[center_id]
        
        # For each selected paper, find its most similar papers
        all_similar_papers = []
        seen_ids = set([center_id] + selected_ids)  # Track papers we've already considered
        
        for sid in selected_ids:
            if sid < len(paper_similarities):
                similar_papers = paper_similarities[sid]
                for paper in similar_papers:
                    original_id = paper.get("original_id")
                    if original_id is not None and original_id not in seen_ids:
                        all_similar_papers.append((paper, float(paper.get("score", 0))))
                        seen_ids.add(original_id)
        
        # Sort all similar papers by score and take top N
        all_similar_papers.sort(key=lambda x: x[1], reverse=True)
        top_similar_papers = []
        
        # First, include the selected papers themselves
        for i, sid in enumerate(selected_ids):
            paper_data = data[sid]
            top_similar_papers.append({
                "id": i + 1,
                "original_id": sid,
                "title": paper_data.get("title", "Unknown"),
                "abstract": paper_data.get("abstract", ""),
                "link": paper_data.get("link", ""),
                "score": 0.95,  # High score for selected papers
                "citations": paper_data.get("citation_count", 0)
            })
        
        # Then add the most similar papers to fill up to 15 total
        next_id = len(selected_ids) + 1
        for paper, score in all_similar_papers:
            if len(top_similar_papers) >= 15:
                break
            
            original_id = paper.get("original_id")
            if original_id is not None and original_id < len(data):
                paper_data = data[original_id]
                top_similar_papers.append({
                    "id": next_id,
                    "original_id": original_id,
                    "title": paper_data.get("title", paper.get("title", "Unknown")),
                    "abstract": paper_data.get("abstract", paper.get("abstract", "")),
                    "link": paper_data.get("link", paper.get("link", "")),
                    "score": score,
                    "citations": paper_data.get("citation_count", 0)
                })
                next_id += 1
        
        # If we still don't have enough papers, add some random ones
        while len(top_similar_papers) < 15:
            # Find a random paper that we haven't used yet
            random_id = random.randint(0, len(data) - 1)
            if random_id not in seen_ids:
                paper_data = data[random_id]
                top_similar_papers.append({
                    "id": next_id,
                    "original_id": random_id,
                    "title": paper_data.get("title", "Unknown"),
                    "abstract": paper_data.get("abstract", ""),
                    "link": paper_data.get("link", ""),
                    "score": 0.5,  # Lower score for random papers
                    "citations": paper_data.get("citation_count", 0)
                })
                seen_ids.add(random_id)
                next_id += 1
        
        # Format the response
        response_data = {
            "center": {
                "id": 0,
                "original_id": center_id,
                "title": center_paper.get("title", "Unknown"),
                "abstract": center_paper.get("abstract", ""),
                "link": center_paper.get("link", ""),
                "score": 1.0,
                "citations": center_paper.get("citation_count", 0)
            },
            "related": top_similar_papers
        }
        
        response_data = convert_to_serializable(response_data)
        return jsonify(response_data)
    
    except Exception as e:
        print(f"Error in reinforcement: {str(e)}")
        return jsonify({"error": str(e)}), 500 
    
if 'DB_NAME' not in os.environ:
    app.run(debug=True, host="0.0.0.0", port=5000)