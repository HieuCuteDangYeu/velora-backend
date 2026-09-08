from rag_eval.dataset import load_dataset


def test_all_generic_router_rows_have_explicit_action_labels():
    rows = [row for row in load_dataset("rag-generalization-v1") if row.fixtureGroup == "router"]
    assert len(rows) == 65
    assert all(
        row.expectedRecommendationAction in {"NONE", "RECOMMEND_REELS", "SUGGEST_QUERIES"}
        for row in rows
    )
    assert all(
        row.fixture["expected"]["recommendationAction"] == row.expectedRecommendationAction
        for row in rows
    )
