import re
import math

def tokenize(text: str) -> list[str]:
    """Returns a list of words that make up the text.
    
    Note: for simplicity, lowercase everything. Do not remove duplicate words.
    Requirement: Use Regex to satisfy this function
    
    Parameters
    ----------
    text : str
        The input string to be tokenized.
    
    Returns
    -------
    List[str]
        A list of strings representing the words in the text.
    """
    words = re.findall('[A-Za-z]+', text.lower())
    return words

def build_inverted_index(msgs: list[dict]) -> dict:
    """Builds an inverted index from the messages.

    Arguments
    =========
    
    msgs: list of dicts.
        Each message in this list already has a 'toks'
        field that contains the tokenized message.
    
    Returns
    =======
    
    inverted_index: dict
        For each term, the index contains
        a sorted list of tuples (title, count_of_term_in_doc)
        inverted_index[term] = [(d1, tf1), (d2, tf2), ...]
    
    Example
    =======
    >> test_idx = build_inverted_index([
    ...    {'toks': ['to', 'be', 'or', 'not', 'to', 'be']},
    ...    {'toks': ['do', 'be', 'do', 'be', 'do']}])
    
    >> test_idx['be']
    [(0, 2), (1, 2)]
    
    >> test_idx['not']
    [(0, 1)]
    
    """
    term_index = {}
    count = 0
    for d in msgs:
      word_dict = {}
      title = count
      for word in d['toks']:
        word_dict[word] = word_dict.get(word, 0) + 1
      for w in word_dict:
        if w not in term_index:
          term_index[w] = [(title,word_dict[w])]
        else:
           term_index[w].append((title,word_dict[w]))
      count += 1
    return dict(sorted(term_index.items(), key=lambda x: x[0]))

def tf(t, text):
    """Calculates term frequency of term `t` in the text.
    
    Term frequency is the number of times a term appears in a document
    divided by the total number of terms in the document.
    """
    tokens = tokenize(text['abstract'])
    if not tokens:
        return 0
    
    term_count = tokens.count(t.lower())
    return term_count / len(tokens)

def idf(t, inv_index, total):
    """Calculates inverse document frequency of term `t`.
    
    IDF measures how important a term is by checking if it's common or rare
    across all documents.
    """
    # Check if term exists in the inverted index
    if t not in inv_index:
        return 0
    
    # Calculate IDF
    return math.log(total / len(inv_index[t]))

def tf_idf(inv_index, docs):
    """Calculates tf-idf for all documents"""
    num_docs = len(docs)
    tfidf_matrix = {}
    
    # Get all terms in the corpus
    all_terms = set(inv_index.keys())
    
    for doc_id, doc in enumerate(docs):
        tfidf_matrix[doc_id] = {}
        tokens = set(tokenize(doc['abstract']))
        
        for term in tokens:
            if term in all_terms:  # Only calculate for terms in the inverted index
                tf_val = tf(term, doc)
                idf_val = idf(term, inv_index, num_docs)
                tfidf_matrix[doc_id][term] = tf_val * idf_val
    
    return tfidf_matrix

def cossim(a, b):
    """Computes cosine similarity between two TF-IDF vectors."""
    # Handle empty vectors
    if not a or not b:
        return 0.0
    
    # Calculate dot product
    dotprod = sum(a.get(term, 0) * b.get(term, 0) for term in set(a.keys()).union(b.keys()))
    
    # Calculate vector norms
    norm_a = math.sqrt(sum(i ** 2 for i in a.values()))
    norm_b = math.sqrt(sum(i ** 2 for i in b.values()))
    
    # Return cosine similarity
    return dotprod / (norm_a * norm_b) if norm_a and norm_b else 0.0

def search(query, docs, inv_index):
    """Finds the most relevant research papers based on a query.
    
    Returns complete document objects with title, abstract, and link.
    """
    # Handle empty query or documents
    if not query or not docs:
        return []
    
    num_docs = len(docs)
    
    # Calculate TF-IDF for all documents
    tfidf_matrix = tf_idf(inv_index, docs)
    
    # Process query
    query_tokens = tokenize(query)
    
    # Create a pseudo-document for the query
    query_doc = {"abstract": query}
    query_tfidf = {}
    
    # Calculate TF-IDF for query terms
    for term in set(query_tokens):
        tf_val = tf(term, query_doc)
        idf_val = idf(term, inv_index, num_docs)
        query_tfidf[term] = tf_val * idf_val
    
    # Calculate similarity scores for each document
    sim_scores = []
    for doc_id, doc_tfidf in tfidf_matrix.items():
        score = cossim(query_tfidf, doc_tfidf)
        # Store the full document object and its score
        sim_scores.append((docs[doc_id], score))
    
    # Sort by similarity score in descending order
    ranked_docs = sorted(sim_scores, key=lambda x: x[1], reverse=True)
    
    # Return top 5 documents (just the document objects, not the scores)
    return [doc for doc, score in ranked_docs[:5]]