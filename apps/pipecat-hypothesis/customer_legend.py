"""Per-call fictional customer identity, separate from verified seller facts."""
import re
import secrets
from customer_grammar import customer_gender


def choose_name(prompt):
    explicit=re.findall(r'[Тт]ы\s+([А-ЯЁ][а-яё-]+)\s*,\s*(?:женщина|мужчина)',prompt)
    if explicit:return explicit[-1]
    female=customer_gender(prompt)=='female'
    names=('Анна','Мария','Елена','Ольга','Наталья','Ирина','Татьяна','Екатерина') if female else (
        'Алексей','Дмитрий','Сергей','Михаил','Иван','Андрей','Николай','Павел')
    return secrets.choice(names)
