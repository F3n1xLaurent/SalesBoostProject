"""Per-call fictional customer identity, separate from verified seller facts."""
import re
import secrets


def choose_name(prompt):
    explicit=re.findall(r'[Тт]ы\s+([А-ЯЁ][а-яё-]+)\s*,\s*(?:женщина|мужчина)',prompt)
    if explicit:return explicit[-1]
    female=bool(re.search(r'Голос клиента:\s*Женский',prompt,re.I))
    names=('Анна','Мария','Елена','Ольга','Наталья','Ирина','Татьяна','Екатерина') if female else (
        'Алексей','Дмитрий','Сергей','Михаил','Иван','Андрей','Николай','Павел')
    return secrets.choice(names)
