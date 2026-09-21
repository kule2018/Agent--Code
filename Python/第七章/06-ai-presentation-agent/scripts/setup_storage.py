"""初始化 PostgreSQL 业务表与 LangGraph Checkpoint 表。"""

from langgraph.checkpoint.postgres import PostgresSaver

from presentation_repository import PostgresPresentationRepository, get_postgres_uri


def main() -> None:
    repository = PostgresPresentationRepository(get_postgres_uri())
    try:
        repository.setup()
        with PostgresSaver.from_conn_string(get_postgres_uri()) as checkpointer:
            checkpointer.setup()
        print("数据库与 LangGraph Checkpoint 表初始化完成。")
    finally:
        repository.close()


if __name__ == "__main__":
    main()
